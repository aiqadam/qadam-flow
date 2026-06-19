import { QadamAuth, createQadam } from '@aiqadam/qadams-framework';
import { fetchCryptoPairPrice } from './lib/actions/fetch-pair-price';

export const binance = createQadam({
  displayName: 'Binance',
  description: 'Fetch the price of a crypto pair from Binance',
  minimumSupportedRelease: '0.30.0',
  logoUrl: '/assets/qadams/binance.png',
  categories: [],
  auth: QadamAuth.None(),
  actions: [fetchCryptoPairPrice],
  authors: ["kishanprmr","khaledmashaly","abuaboud"],
  triggers: [],
});
