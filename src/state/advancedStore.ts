import { create } from 'zustand';
import { analyzeLinuxOutput, buildStrategyGraph, simulateRoute, type GraphEdge, type LinuxFinding } from '../core/advanced';
import { useConfigStore } from './configStore';
import { useSubscriptionStore } from './subscriptionStore';

type AdvancedState = {
  target: string;
  linuxOutput: string;
  simulation: ReturnType<typeof simulateRoute> | null;
  findings: LinuxFinding[];
  graph: GraphEdge[];
  setTarget: (target: string) => void;
  setLinuxOutput: (output: string) => void;
  runSimulation: () => void;
  analyzeLinux: () => void;
  refreshGraph: () => void;
};

export const useAdvancedStore = create<AdvancedState>((set, get) => ({
  target: 'www.example.com',
  linuxOutput: '',
  simulation: null,
  findings: [],
  graph: [],
  setTarget: (target) => set({ target }),
  setLinuxOutput: (linuxOutput) => set({ linuxOutput }),
  runSimulation: () => {
    try {
      const config = JSON.parse(useConfigStore.getState().content);
      set({ simulation: simulateRoute(config, get().target) });
    } catch {
      set({ simulation: { matchedRule: 'invalid config', outbound: 'unknown' } });
    }
  },
  analyzeLinux: () => set({ findings: analyzeLinuxOutput(get().linuxOutput) }),
  refreshGraph: () => set({ graph: buildStrategyGraph(useSubscriptionStore.getState().outbounds as never) })
}));
