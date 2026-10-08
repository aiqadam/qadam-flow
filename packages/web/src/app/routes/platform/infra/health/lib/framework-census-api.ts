import { FrameworkCensusResponse } from '@aiqadam/shared';

import { api } from '@/lib/api';

export const frameworkCensusApi = {
  getCensus(): Promise<FrameworkCensusResponse> {
    return api.get<FrameworkCensusResponse>('/v1/framework-census');
  },
};
