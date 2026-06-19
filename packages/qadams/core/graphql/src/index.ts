
import { createQadam, QadamAuth } from "@aiqadam/qadams-framework";
import { query } from "./lib/actions/query";
import { QadamCategory } from "@aiqadam/shared";
    
    export const graphql = createQadam({
      displayName: "GraphQL",
      auth: QadamAuth.None(),
      minimumSupportedRelease: '0.30.0',
      logoUrl: "/assets/qadams/graphql.svg",
      categories:[QadamCategory.CORE],
      authors: ['mahmuthamet'],
      actions: [query],
      triggers: [],
    });
    