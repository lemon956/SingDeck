import { create } from 'zustand';
import {
  buildSelectorOutbound,
  detectRuleHints,
  parseSubscriptionLines,
  type OutboundDraft,
  type RuleHint
} from '../core/subscriptions';

type SubscriptionState = {
  raw: string;
  outbounds: OutboundDraft[];
  selector: OutboundDraft | null;
  hints: RuleHint[];
  setRaw: (raw: string) => void;
  parse: () => void;
};

export const useSubscriptionStore = create<SubscriptionState>((set, get) => ({
  raw: '',
  outbounds: [],
  selector: null,
  hints: [],
  setRaw: (raw) => set({ raw }),
  parse: () => {
    const outbounds = parseSubscriptionLines(get().raw);
    set({
      outbounds,
      selector: outbounds.length > 0 ? buildSelectorOutbound('Manual', outbounds.map((outbound) => outbound.tag)) : null,
      hints: detectRuleHints([])
    });
  }
}));
