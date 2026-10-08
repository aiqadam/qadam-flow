import { useQuery } from '@tanstack/react-query';

import { frameworkCensusApi } from './framework-census-api';

export const frameworkCensusQueries = {
  // Once a release has retired a context version the census walks every flow of the platform, so
  // it is fetched where an operator asks for platform status — not on a page every user opens.
  // Until then the server answers without walking anything (`ran: false`). A failure here is
  // auxiliary: the banner simply does not appear (no `showErrorDialog`).
  useCensus: () => {
    return useQuery({
      queryKey: ['framework-census'],
      queryFn: () => frameworkCensusApi.getCensus(),
      staleTime: 5 * 60 * 1000,
    });
  },
};
