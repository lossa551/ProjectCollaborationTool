import type { PctApi } from '../common/api';

declare global {
  interface Window {
    pct: PctApi;
  }
}
