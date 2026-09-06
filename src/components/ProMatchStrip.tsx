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
      className="flex-shrink-0 flex items-center gap-2 px-3 py-1.5 bg-k3-surface hover:bg-k3-elevated border border-k3-border-subtle rounded-lg transition-all group"
    >
      <span className="text-[9px] text-k3-text-tertiary truncate max-w-[60px]">{match.leagueName}</span>
      <span className={`text-[10px] font-medium truncate max-w-[50px] ${match.radiantWin ? 'text-k3-radiant' : 'text-k3-text-secondary'}`}>
        {match.radiantTeam}
      </span>
      <span className="text-[9px] text-k3-text-tertiary">{t.vs}</span>
      <span className={`text-[10px] font-medium truncate max-w-[50px] ${!match.radiantWin ? 'text-k3-dire' : 'text-k3-text-secondary'}`}>
        {match.direTeam}
      </span>
      <span className="text-[9px] text-k3-text-tertiary flex items-center gap-0.5">
        <Clock size={8} />
        {formatDuration(match.duration)}
      </span>
      <ExternalLink size={10} className="text-k3-text-tertiary group-hover:text-k3-accent" />
    </a>
  );

  const renderPublicMatch = (match: PublicMatch) => (
    <a
      key={match.matchId}
      href={match.opendotaUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="flex-shrink-0 flex items-center gap-2 px-3 py-1.5 bg-k3-surface hover:bg-k3-elevated border border-k3-border-subtle rounded-lg transition-all group"
    >
      <span className="text-[9px] px-1.5 py-0.5 bg-k3-elevated text-k3-text-secondary rounded">
        {match.mmrLabel || 'N/A'}
      </span>
      
      <div className="flex -space-x-1">
        {match.radiantHeroes.slice(0, 3).map((hero, idx) => (
          hero.icon ? (
            <img 
              key={idx} 
              src={hero.icon} 
              alt={hero.name}
              title={hero.name}
              className={`w-4 h-4 rounded border ${match.radiantWin ? 'border-k3-radiant/40' : 'border-k3-border-subtle'}`}
            />
          ) : (
            <div 
              key={idx}
              className={`w-4 h-4 rounded bg-k3-elevated border ${match.radiantWin ? 'border-k3-radiant/40' : 'border-k3-border-subtle'}`}
            />
          )
        ))}
      </div>
      <span className="text-[9px] text-k3-text-tertiary">{t.vs}</span>
      <div className="flex -space-x-1">
        {match.direHeroes.slice(0, 3).map((hero, idx) => (
          hero.icon ? (
            <img 
              key={idx} 
              src={hero.icon} 
              alt={hero.name}
              title={hero.name}
              className={`w-4 h-4 rounded border ${!match.radiantWin ? 'border-k3-dire/40' : 'border-k3-border-subtle'}`}
            />
          ) : (
            <div 
              key={idx}
              className={`w-4 h-4 rounded bg-k3-elevated border ${!match.radiantWin ? 'border-k3-dire/40' : 'border-k3-border-subtle'}`}
            />
          )
        ))}
      </div>
      
      <span className={`text-[9px] ${match.radiantWin ? 'text-k3-radiant' : 'text-k3-dire'}`}>
        {match.radiantWin ? t.radiant : t.dire} {t.win}
      </span>
      <span className="text-[9px] text-k3-text-tertiary flex items-center gap-0.5">
        <Clock size={8} />
        {formatDuration(match.duration)}
      </span>
      <ExternalLink size={10} className="text-k3-text-tertiary group-hover:text-k3-accent" />
    </a>
  );

  if (isLoading) {
    return (
      <div className="h-10 flex items-center justify-center text-k3-text-tertiary text-xs">
        <RefreshCw size={12} className="animate-spin mr-1.5" />
        {t.loading}
      </div>
    );
  }

  if (proMatches.length === 0 && publicMatches.length === 0) {
    return null;
  }

  return (
    <div className="h-10 flex items-center gap-2">
      {/* Tab buttons */}
      <div className="flex gap-1 flex-shrink-0">
        <button
          onClick={() => { setActiveTab('pro'); setScrollIndex(0); }}
          className={`flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-medium transition-colors ${
            activeTab === 'pro'
              ? 'bg-k3-surface text-k3-text-primary border border-k3-accent/30'
              : 'text-k3-text-tertiary hover:text-k3-text-secondary border border-transparent'
          }`}
        >
          <Trophy size={10} />
          {t.proMatches}
        </button>
        <button
          onClick={() => { setActiveTab('public'); setScrollIndex(0); }}
          className={`flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-medium transition-colors ${
            activeTab === 'public'
              ? 'bg-k3-surface text-k3-text-primary border border-k3-accent/30'
              : 'text-k3-text-tertiary hover:text-k3-text-secondary border border-transparent'
          }`}
        >
          <Users size={10} />
          {t.publicMatches}
        </button>
      </div>

      {/* Divider */}
      <div className="w-px h-5 bg-k3-border-subtle flex-shrink-0" />
      
      {/* Match cards */}
      <div className="flex gap-2 overflow-hidden flex-1">
        {visibleMatches.length > 0 ? (
          activeTab === 'pro' 
            ? visibleMatches.map(m => renderProMatch(m as ProMatch))
            : visibleMatches.map(m => renderPublicMatch(m as PublicMatch))
        ) : (
          <div className="flex-1 text-center text-k3-text-tertiary text-xs">{t.noData}</div>
        )}
      </div>
      
      {/* Navigation arrows */}
      {currentMatches.length > 3 && (
        <div className="flex gap-1 flex-shrink-0">
          <button
            onClick={handleScrollLeft}
            disabled={!canScrollLeft}
            className="p-1 rounded hover:bg-k3-elevated disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <ChevronLeft size={14} className="text-k3-text-tertiary" />
          </button>
          <button
            onClick={handleScrollRight}
            disabled={!canScrollRight}
            className="p-1 rounded hover:bg-k3-elevated disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <ChevronRight size={14} className="text-k3-text-tertiary" />
          </button>
        </div>
      )}
    </div>
  );
};

export default ProMatchStrip;
