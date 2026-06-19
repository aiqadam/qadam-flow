import { createAction } from '@aiqadam/qadams-framework';

export const getRunId = createAction({
  // auth: check https://flow.aiqadam.org/docs/developers/qadam-reference/authentication,
  name: 'getRunId',
  displayName: 'Get Run Info',
  description: '',
  props: {},
  async run(context) {
    const publicUrlWithoutApi = context.server.publicUrl.replace('/api', '');
    return {
      id: context.run.id,
      url: `${publicUrlWithoutApi}projects/${context.project.id}/runs/${context.run.id}`
    }
  },
});
