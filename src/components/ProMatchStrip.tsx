import React, { useState, useEffect, useMemo } from 'react';
import { Language } from '../types';
import { 
  fetchProMatches, 
  fetchPublicMatches,
  ProMatch,
  PublicMatch 
} from '../services/geminiService';
import { Trophy, Users, Clock, ExternalLink, ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react';

interface ProMatchStripProps {
  lang: Language;
}

type MatchTab = 'pro' | 'public';

const ProMatchStrip: React.FC<ProMatchStripProps> = ({ lang }) => {
  const [activeTab, setActiveTab] = useState<MatchTab>('pro');
  const [proMatches, setProMatches] = useState<ProMatch[]>([]);
  const [publicMatches, setPublicMatches] = useState<PublicMatch[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [scrollIndex, setScrollIndex] = useState(0);

  const t = useMemo(() => ({
    proMatches: lang === 'zh' ? '职业比赛' : 'Pro Matches',
    publicMatches: lang === 'zh' ? '高分对局' : 'High MMR',
    loading: lang === 'zh' ? '加载中...' : 'Loading...',
    noData: lang === 'zh' ? '暂无数据' : 'No data',
    win: lang === 'zh' ? '胜' : 'W',
    lose: lang === 'zh' ? '负' : 'L',
    viewOnOpenDota: lang === 'zh' ? '在 OpenDota 查看' : 'View on OpenDota',
    vs: 'vs',
    radiant: lang === 'zh' ? '天辉' : 'Radiant',
    dire: lang === 'zh' ? '夜魇' : 'Dire',
  }), [lang]);

  useEffect(() => {
    const loadData = async () => {
      setIsLoading(true);
      const [proData, publicData] = await Promise.all([
        fetchProMatches(lang, 8),
        fetchPublicMatches(lang, 8)
      ]);
      setProMatches(proData.matches);
      setPublicMatches(publicData.matches);
      setIsLoading(false);
    };
    loadData();
  }, [lang]);

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    return `${mins}${lang === 'zh' ? '分钟' : 'm'}`;
  };

  const formatTimeAgo = (timestamp: number) => {
    const now = Date.now() / 1000;
    const diff = now - timestamp;
    const hours = Math.floor(diff / 3600);
    const days = Math.floor(diff / 86400);
    
    if (days > 0) {
      return lang === 'zh' ? `${days}天前` : `${days}d ago`;
    }
    if (hours > 0) {
      return lang === 'zh' ? `${hours}小时前` : `${hours}h ago`;
    }
    return lang === 'zh' ? '刚刚' : 'Just now';
  };

  const currentMatches = activeTab === 'pro' ? proMatches : publicMatches;
  const visibleMatches = currentMatches.slice(scrollIndex, scrollIndex + 3);
  const canScrollLeft = scrollIndex > 0;
  const canScrollRight = scrollIndex + 3 < currentMatches.length;

  const handleScrollLeft = () => {
    setScrollIndex(Math.max(0, scrollIndex - 1));
  };

  const handleScrollRight = () => {
    setScrollIndex(Math.min(currentMatches.length - 3, scrollIndex + 1));
  };

  const renderProMatch = (match: ProMatch) => (
    <a
      key={match.matchId}
      href={match.opendotaUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="flex-shrink-0 w-[180px] sm:w-[200px] bg-gray-900/60 hover:bg-gray-800/80 border border-gray-700/50 hover:border-dota-gold/50 rounded-lg p-2 transition-all group"
    >
      <div className="flex items-center justify-between mb-1">
        <span className="text-[9px] text-gray-500 truncate max-w-[100px]">{match.leagueName}</span>
        <span className="text-[9px] text-gray-600">{formatTimeAgo(match.startTime)}</span>
      </div>
      <div className="flex items-center gap-1.5 mb-1">
        <span className={`text-[10px] font-medium truncate max-w-[70px] ${match.radiantWin ? 'text-dota-green' : 'text-gray-400'}`}>
          {match.radiantTeam}
        </span>
        <span className="text-[9px] text-gray-600">{t.vs}</span>
        <span className={`text-[10px] font-medium truncate max-w-[70px] ${!match.radiantWin ? 'text-dota-red' : 'text-gray-400'}`}>
          {match.direTeam}
        </span>
      </div>
      <div className="flex items-center justify-between text-[9px]">
        <span className={match.radiantWin ? 'text-dota-green' : 'text-dota-red'}>
          {match.radiantWin ? t.radiant : t.dire} {t.win}
        </span>
        <span className="text-gray-500 flex items-center gap-0.5">
          <Clock size={8} />
          {formatDuration(match.duration)}
        </span>
        <ExternalLink size={10} className="text-gray-600 group-hover:text-dota-gold" />
      </div>
    </a>
  );

  const renderPublicMatch = (match: PublicMatch) => (
    <a
      key={match.matchId}
      href={match.opendotaUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="flex-shrink-0 w-[180px] sm:w-[200px] bg-gray-900/60 hover:bg-gray-800/80 border border-gray-700/50 hover:border-dota-gold/50 rounded-lg p-2 transition-all group"
    >
      <div className="flex items-center justify-between mb-1">
        <span className="text-[9px] px-1.5 py-0.5 bg-purple-500/20 text-purple-400 rounded">
          {match.mmrLabel || 'N/A'}
        </span>
        <span className="text-[9px] text-gray-600">{formatTimeAgo(match.startTime)}</span>
      </div>
      
      <div className="flex items-center gap-1 mb-1">
        <div className="flex -space-x-1">
          {match.radiantHeroes.slice(0, 3).map((hero, idx) => (
            hero.icon ? (
              <img 
                key={idx} 
                src={hero.icon} 
                alt={hero.name}
                title={hero.name}
                className={`w-4 h-4 rounded border ${match.radiantWin ? 'border-dota-green/50' : 'border-gray-600'}`}
              />
            ) : (
              <div 
                key={idx}
                className={`w-4 h-4 rounded bg-gray-700 border ${match.radiantWin ? 'border-dota-green/50' : 'border-gray-600'}`}
              />
            )
          ))}
          {match.radiantHeroes.length > 3 && (
            <span className="w-4 h-4 rounded bg-gray-800 border border-gray-600 flex items-center justify-center text-[7px] text-gray-500">
              +{match.radiantHeroes.length - 3}
            </span>
          )}
        </div>
        <span className="text-[9px] text-gray-600">{t.vs}</span>
        <div className="flex -space-x-1">
          {match.direHeroes.slice(0, 3).map((hero, idx) => (
            hero.icon ? (
              <img 
                key={idx} 
                src={hero.icon} 
                alt={hero.name}
                title={hero.name}
                className={`w-4 h-4 rounded border ${!match.radiantWin ? 'border-dota-red/50' : 'border-gray-600'}`}
              />
            ) : (
              <div 
                key={idx}
                className={`w-4 h-4 rounded bg-gray-700 border ${!match.radiantWin ? 'border-dota-red/50' : 'border-gray-600'}`}
              />
            )
          ))}
          {match.direHeroes.length > 3 && (
            <span className="w-4 h-4 rounded bg-gray-800 border border-gray-600 flex items-center justify-center text-[7px] text-gray-500">
              +{match.direHeroes.length - 3}
            </span>
          )}
        </div>
      </div>
      
      <div className="flex items-center justify-between text-[9px]">
        <span className={match.radiantWin ? 'text-dota-green' : 'text-dota-red'}>
          {match.radiantWin ? t.radiant : t.dire} {t.win}
        </span>
        <span className="text-gray-500 flex items-center gap-0.5">
          <Clock size={8} />
          {formatDuration(match.duration)}
        </span>
        <ExternalLink size={10} className="text-gray-600 group-hover:text-dota-gold" />
      </div>
    </a>
  );

  if (isLoading) {
    return (
      <div className="glass-panel rounded-lg p-2 mb-3">
        <div className="flex items-center justify-center py-2 text-gray-500 text-xs">
          <RefreshCw size={12} className="animate-spin mr-1.5" />
          {t.loading}
        </div>
      </div>
    );
  }

  if (proMatches.length === 0 && publicMatches.length === 0) {
    return null;
  }

  return (
    <div className="glass-panel rounded-lg p-2 mb-3">
      <div className="flex items-center justify-between mb-2">
        <div className="flex gap-1">
          <button
            onClick={() => { setActiveTab('pro'); setScrollIndex(0); }}
            className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
              activeTab === 'pro'
                ? 'bg-dota-gold/20 text-dota-gold border border-dota-gold/30'
                : 'text-gray-500 hover:text-gray-300 border border-transparent'
            }`}
          >
            <Trophy size={10} />
            {t.proMatches}
          </button>
          <button
            onClick={() => { setActiveTab('public'); setScrollIndex(0); }}
            className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
              activeTab === 'public'
                ? 'bg-purple-500/20 text-purple-400 border border-purple-500/30'
                : 'text-gray-500 hover:text-gray-300 border border-transparent'
            }`}
          >
            <Users size={10} />
            {t.publicMatches}
          </button>
        </div>
        
        {currentMatches.length > 3 && (
          <div className="flex gap-1">
            <button
              onClick={handleScrollLeft}
              disabled={!canScrollLeft}
              className="p-0.5 rounded hover:bg-gray-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronLeft size={14} className="text-gray-400" />
            </button>
            <button
              onClick={handleScrollRight}
              disabled={!canScrollRight}
              className="p-0.5 rounded hover:bg-gray-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronRight size={14} className="text-gray-400" />
            </button>
          </div>
        )}
      </div>
      
      <div className="flex gap-2 overflow-hidden">
        {visibleMatches.length > 0 ? (
          activeTab === 'pro' 
            ? visibleMatches.map(m => renderProMatch(m as ProMatch))
            : visibleMatches.map(m => renderPublicMatch(m as PublicMatch))
        ) : (
          <div className="flex-1 text-center py-2 text-gray-500 text-xs">{t.noData}</div>
        )}
      </div>
    </div>
  );
};

export default ProMatchStrip;
