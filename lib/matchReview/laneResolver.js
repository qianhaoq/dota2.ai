/**
 * 根据 OpenDota lane_pos 网格站位聚类推断真实分路。
 * 绝不单独信任 lane / lane_role 字段判定对线对手。
 */

const LANE_CLUSTER_SOURCE = 'lane_pos_cluster';
const LANE_FALLBACK_SOURCE = 'lane_pos_unavailable';
const AMBIGUOUS_CLUSTER_RATIO = 1.55;

/** @typedef {{ x: number, y: number, samples: number }} LaneCentroid */
/** @typedef {{ heroId: number, playerSlot: number, isRadiant: boolean, centroid: LaneCentroid | null }} PlayerPosition */

/**
 * 从 lane_pos 网格计算加权质心。
 * @param {Record<string, Record<string, number>> | null | undefined} lanePos
 * @returns {LaneCentroid | null}
 */
export function computeLaneCentroid(lanePos) {
  if (!lanePos || typeof lanePos !== 'object') return null;

  let sumX = 0;
  let sumY = 0;
  let samples = 0;

  for (const [xKey, yCounts] of Object.entries(lanePos)) {
    const x = Number(xKey);
    if (!yCounts || typeof yCounts !== 'object') continue;
    for (const [yKey, count] of Object.entries(yCounts)) {
      const y = Number(yKey);
      const c = Number(count) || 0;
      if (c <= 0) continue;
      sumX += x * c;
      sumY += y * c;
      samples += c;
    }
  }

  if (samples <= 0) return null;
  return { x: sumX / samples, y: sumY / samples, samples };
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * k-means++ 风格初始化，避免陷入错误局部最优。
 */
function initCentroids(points, k) {
  const centroids = [{ x: points[0].centroid.x, y: points[0].centroid.y }];
  while (centroids.length < k) {
    let bestPoint = points[0];
    let bestMinDist = -1;
    for (const p of points) {
      const minDist = Math.min(...centroids.map((c) => distance(p.centroid, c)));
      if (minDist > bestMinDist) {
        bestMinDist = minDist;
        bestPoint = p;
      }
    }
    centroids.push({ x: bestPoint.centroid.x, y: bestPoint.centroid.y });
  }
  return centroids;
}

/**
 * 简单 k-means，k 默认为 3（上/中/下三路）。
 */
function kMeansCluster(points, k = 3, maxIter = 40) {
  if (points.length === 0) return { centroids: [], assignments: [] };
  const effectiveK = Math.min(k, points.length);

  let centroids = initCentroids(points, effectiveK);

  for (let iter = 0; iter < maxIter; iter++) {
    const groups = Array.from({ length: effectiveK }, () => []);
    for (const p of points) {
      let best = 0;
      let bestDist = Infinity;
      for (let j = 0; j < effectiveK; j++) {
        const d = distance(p.centroid, centroids[j]);
        if (d < bestDist) {
          bestDist = d;
          best = j;
        }
      }
      groups[best].push(p);
    }

    let moved = false;
    for (let j = 0; j < effectiveK; j++) {
      if (groups[j].length === 0) continue;
      const next = {
        x: groups[j].reduce((s, p) => s + p.centroid.x, 0) / groups[j].length,
        y: groups[j].reduce((s, p) => s + p.centroid.y, 0) / groups[j].length,
      };
      if (distance(next, centroids[j]) > 0.01) moved = true;
      centroids[j] = next;
    }
    if (!moved) break;
  }

  const assignments = points.map((p) => {
    let best = 0;
    let bestDist = Infinity;
    for (let j = 0; j < effectiveK; j++) {
      const d = distance(p.centroid, centroids[j]);
      if (d < bestDist) {
        bestDist = d;
        best = j;
      }
    }
    return { ...p, clusterId: best, clusterDistance: bestDist };
  });

  return { centroids, assignments };
}

/**
 * 按质心 y 坐标给簇命名：y 小=上，中=中，大=下。
 */
function labelClusters(centroids) {
  const indexed = centroids.map((c, i) => ({ ...c, index: i }));
  const sorted = [...indexed].sort((a, b) => a.y - b.y);
  const labels = ['top', 'mid', 'bot'];
  const map = {};
  sorted.forEach((c, rank) => {
    const label = labels[Math.min(rank, labels.length - 1)] || `lane_${rank}`;
    map[c.index] = label;
  });
  return map;
}

function confidenceFromDistance(dist, clusterSpread) {
  const spread = Math.max(clusterSpread, 8);
  const ratio = dist / spread;
  if (ratio <= 0.45) return 'high';
  if (ratio <= 0.85) return 'medium';
  return 'low';
}

function numericConfidence(level) {
  return level === 'high' ? 0.92 : level === 'medium' ? 0.72 : 0.45;
}

/**
 * @param {Array<{ hero_id: number, player_slot: number, lane_pos?: Record<string, Record<string, number>> }>} players
 */
export function resolveLanes(players) {
  const positions = players.map((p) => {
    const centroid = computeLaneCentroid(p.lane_pos);
    return {
      heroId: p.hero_id,
      playerSlot: p.player_slot,
      isRadiant: p.player_slot < 128,
      centroid,
    };
  });

  const withCentroid = positions.filter((p) => p.centroid);
  if (withCentroid.length < 2) {
    return {
      lanes: [],
      players: positions.map((p) => ({
        heroId: p.heroId,
        playerSlot: p.playerSlot,
        isRadiant: p.isRadiant,
        laneLabel: 'unknown',
        clusterId: -1,
        centroid: p.centroid,
        allies: [],
        opponents: [],
        nearby: [],
        source: LANE_FALLBACK_SOURCE,
        confidence: 'low',
        confidenceScore: 0.3,
      })),
      source: LANE_FALLBACK_SOURCE,
    };
  }

  const { centroids, assignments } = kMeansCluster(withCentroid, 3);
  const clusterLabels = labelClusters(centroids);

  const clusterMembers = {};
  for (const a of assignments) {
    if (!clusterMembers[a.clusterId]) clusterMembers[a.clusterId] = [];
    clusterMembers[a.clusterId].push(a);
  }

  const clusterStats = {};
  for (const [clusterId, members] of Object.entries(clusterMembers)) {
    const dists = members.map((m) => m.clusterDistance);
    clusterStats[clusterId] = {
      spread: dists.reduce((s, d) => s + d, 0) / dists.length,
      centroid: centroids[Number(clusterId)],
    };
  }

  /** 英雄是否更像在相邻路游走（如 SB） */
  function isWanderingEnemy(enemy, clusterId) {
    const ownDist = enemy.clusterDistance;
    const altDists = centroids
      .map((c, idx) => (idx === clusterId ? null : distance(enemy.centroid, c)))
      .filter((d) => d !== null);
    if (altDists.length === 0) return false;
    const nearestAlt = Math.min(...altDists);
    return nearestAlt / ownDist < AMBIGUOUS_CLUSTER_RATIO;
  }

  const resolvedPlayers = positions.map((p) => {
    const assigned = assignments.find((a) => a.heroId === p.heroId);
    if (!assigned || !p.centroid) {
      return {
        heroId: p.heroId,
        playerSlot: p.playerSlot,
        isRadiant: p.isRadiant,
        laneLabel: 'unknown',
        clusterId: -1,
        centroid: p.centroid,
        allies: [],
        opponents: [],
        nearby: [],
        source: LANE_FALLBACK_SOURCE,
        confidence: 'low',
        confidenceScore: 0.3,
      };
    }

    const clusterId = assigned.clusterId;
    const laneLabel = clusterLabels[clusterId] || 'unknown';
    const members = clusterMembers[clusterId] || [];
    const spread = clusterStats[clusterId]?.spread ?? 12;

    const allies = members
      .filter((m) => m.isRadiant === p.isRadiant && m.heroId !== p.heroId)
      .map((m) => ({
        heroId: m.heroId,
        confidence: confidenceFromDistance(m.clusterDistance, spread),
        source: LANE_CLUSTER_SOURCE,
      }));

    const enemies = members
      .filter((m) => m.isRadiant !== p.isRadiant)
      .map((m) => ({
        heroId: m.heroId,
        centroid: m.centroid,
        clusterDistance: m.clusterDistance,
        heroDistance: distance(p.centroid, m.centroid),
        confidence: confidenceFromDistance(m.clusterDistance, spread),
        source: LANE_CLUSTER_SOURCE,
      }))
      .sort((a, b) => a.heroDistance - b.heroDistance);

    const opponents = [];
    const nearby = [];

    if (enemies.length > 0) {
      for (const e of enemies) {
        if (isWanderingEnemy(e, clusterId)) {
          nearby.push({
            heroId: e.heroId,
            confidence: 'medium',
            source: LANE_CLUSTER_SOURCE,
          });
        } else {
          opponents.push({
            heroId: e.heroId,
            confidence: e.confidence,
            source: LANE_CLUSTER_SOURCE,
          });
        }
      }
    }

    const selfConfidence = confidenceFromDistance(assigned.clusterDistance, spread);

    return {
      heroId: p.heroId,
      playerSlot: p.playerSlot,
      isRadiant: p.isRadiant,
      laneLabel,
      clusterId,
      centroid: p.centroid,
      allies,
      opponents,
      nearby,
      source: LANE_CLUSTER_SOURCE,
      confidence: selfConfidence,
      confidenceScore: numericConfidence(selfConfidence),
    };
  });

  const lanes = Object.entries(clusterMembers).map(([clusterId, members]) => {
    const id = Number(clusterId);
    return {
      clusterId: id,
      laneLabel: clusterLabels[id] || 'unknown',
      centroid: centroids[id],
      radiantHeroIds: members.filter((m) => m.isRadiant).map((m) => m.heroId),
      direHeroIds: members.filter((m) => !m.isRadiant).map((m) => m.heroId),
      source: LANE_CLUSTER_SOURCE,
      confidence: members.length >= 3 ? 'high' : 'medium',
    };
  });

  return {
    lanes,
    players: resolvedPlayers,
    source: LANE_CLUSTER_SOURCE,
  };
}

/**
 * 查询某英雄的对线对手 heroId 列表（不含 nearby）。
 */
export function getLaningOpponentIds(resolved, heroId) {
  const player = resolved.players.find((p) => p.heroId === heroId);
  if (!player) return [];
  return player.opponents.map((o) => o.heroId);
}

export { LANE_CLUSTER_SOURCE, LANE_FALLBACK_SOURCE };
