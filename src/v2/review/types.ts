export interface Fact {
    id: string;
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
}
export interface Followup {
    id: string;
    label: string;
    answerable: boolean;
    gap?: string;
    fact_ids?: string[];
}
export interface Review {
    state: string;
    match: {
        id: number;
    };
    player: (Hero & {
        result: 'win' | 'loss';
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
        radiant_gold_adv: number[];
        radiant_xp_adv: number[];
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
