import { QadamAuth } from '@aiqadam/qadams-framework';

const markdownDescription = `
**Authentication**:

1. Begin a conversation with the [Botfather](https://telegram.me/BotFather).
2. Type in "/newbot"
3. Choose a name for your bot
4. Choose a username for your bot.
5. Copy the token value from the Botfather and use it activepieces connection.
6. Congratulations! You can now use your new Telegram connection in your flows.
`;

export const telegramBotAuth = QadamAuth.SecretText({
  displayName: 'Bot Token',
  description: markdownDescription,
  required: true,
});
