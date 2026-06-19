import { QadamsOAuth2AppsMap } from '../utils/oauth2-utils';

const usePiecesOAuth2AppsMap = () => {
  const data: QadamsOAuth2AppsMap = {};
  return {
    data,
    isPending: false,
    refetch: () => {},
  };
};

export const oauthAppsQueries = {
  usePiecesOAuth2AppsMap,
};
