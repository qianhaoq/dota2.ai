export interface Fact {
    id: string;
    /** Present on engine facts; optional in UI fixtures. */
    value?: unknown;
    display: {
        en: string;
        zh: string;
        t?: string;
    };
    t?: number;
    citation: string;
    source_path: string;
}
export interface Hero {
    hero: string;
    hero_id: number;
    team: string;
}
export interface Insight {
    time?: { from: number; to: number };
    id: string;
    status: string;
    claim: {
        text: string;
        phrasing: string;
    };
    fact_ids: string[];
    metrics: {
        fact_id: string;
        label_key: string;
    }[];
    citations: string[];
    /** Registered data gap tied to this insight (e.g. death_locations), if any. */
    data_gap?: string | null;
    /** Engine evidence descriptor: chart kind + highlight window (minutes). */
    evidence?: {
        kind?: string;
        highlight?: number[];
        markers?: string[];
    };
}
export interface Followup {
    id: string;
    label: string;
    answerable: boolean;
    gap?: string;
    fact_ids?: string[];
}
export interface Objective {
    t: number;
    type: string;
    key: string | null;
    team: 'radiant' | 'dire' | null;
    fact_id: string;
}
export interface DeathEntry {
    t: number;
    killer: string | null;
    team_gold_diff_at_t: number | null;
    fact_id?: string;
}
export interface Purchase {
    t: number;
    item: string;
    key_item: boolean;
}
export interface Citation {
    id: string;
    provider: string;
    url: string;
    fetched_at: string;
    fields: string[];
}
export interface Review {
    state: string;
    match: {
        id: number;
        duration_s?: number | null;
        winner?: string | null;
        score?: {
            radiant: number | null;
            dire: number | null;
        };
        patch?: unknown;
        parsed?: boolean;
        start_time?: number | null;
    };
    player: (Hero & {
        result: 'win' | 'loss';
        kda?: (number | null)[];
    }) | null;
    roster: Hero[];
    facts: Record<string, Fact>;
    insights: Insight[];
    followups: Followup[];
    data_gaps: {
        topic: string;
        reason: string;
    }[];
    series: {
        radiant_gold_adv: (number | null)[];
        radiant_xp_adv: (number | null)[];
        perspective?: string;
    };
    objectives?: Objective[];
    deaths?: DeathEntry[];
    purchases?: Purchase[];
    citations?: Citation[];
    meta?: {
        url?: string;
        evidence_url?: string;
        generated_at?: string;
        [key: string]: unknown;
    };
}
export interface StreamError {
    code: string;
    retryable: boolean;
    message_key: string;
}
export interface Frame {
    id?: string;
    event: string;
    data: any;
    retry?: number;
}
