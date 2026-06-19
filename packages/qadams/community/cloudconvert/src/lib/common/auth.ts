import { OAuth2GrantType } from '@aiqadam/shared';
import { QadamAuth, Property } from '@aiqadam/qadams-framework';

export const cloudconvertAuth = QadamAuth.OAuth2({
    description: 'Connect your CloudConvert account using OAuth2',
    authUrl: 'https://cloudconvert.com/oauth/authorize',
    tokenUrl: 'https://cloudconvert.com/oauth/token',
    required: true,
    grantType: OAuth2GrantType.AUTHORIZATION_CODE,
    scope: ['task.read', 'task.write'],
    props: {
        region: Property.StaticDropdown({
            displayName: 'Region',
            description: 'CloudConvert processing region',
            required: true,
            options: {
                options: [
                    { label: 'Auto (Nearest)', value: 'auto' },
                    { label: 'EU Central (Germany)', value: 'eu-central' },
                    { label: 'US East (Virginia)', value: 'us-east' },
                ]
            },
            defaultValue: 'auto'
        })
    }
});
