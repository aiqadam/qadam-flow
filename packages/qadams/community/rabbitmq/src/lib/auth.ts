import { QadamAuth, Property } from '@aiqadam/qadams-framework';

export const rabbitmqAuth = QadamAuth.CustomAuth({
  description: "Rabbitmq Auth",
  required: true,
  props: {
    host: Property.ShortText({
      displayName: "Host",
      description: "Host",
      required: true,
    }),
    username: Property.ShortText({
      displayName: "Username",
      description: "Username",
      required: true,
    }),
    password: QadamAuth.SecretText({
      displayName: "Password",
      description: "Password",
      required: true,
    }),
    port: Property.Number({
      displayName: "Port",
      description: "Port",
      required: true,
    }),
    vhost: Property.ShortText({
      displayName: "Virtual Host",
      description: "Virtual Host",
      required: false,
    }),
  },
});
