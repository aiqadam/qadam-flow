import {
  LdapTestRequest,
  LdapTestResponse,
  PlatformLdapConfig,
  UpsertLdapConfigRequest,
} from '@aiqadam/shared';

import { api } from '@/lib/api';

export const ldapConfigApi = {
  get() {
    return api.get<PlatformLdapConfig | null>('/v1/platform-ldap-configs');
  },
  upsert(request: UpsertLdapConfigRequest) {
    return api.post<PlatformLdapConfig>('/v1/platform-ldap-configs', request);
  },
  delete() {
    return api.delete<void>('/v1/platform-ldap-configs');
  },
  test(request: LdapTestRequest) {
    return api.post<LdapTestResponse>(
      '/v1/platform-ldap-configs/test',
      request,
    );
  },
};
