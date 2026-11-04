import 'dotenv/config';
import { Logger } from '@nestjs/common';
import { API_PREFIX, createApp } from './app.factory';
import { loadEnv } from './config/env';

async function bootstrap() {
  const env = loadEnv();
  const app = await createApp(env);
  await app.listen(env.PORT);
  new Logger('Bootstrap').log(`ClearPort API listening on http://localhost:${env.PORT}/${API_PREFIX}`);
}

bootstrap().catch((e) => {
  console.error(e);
  process.exit(1);
});
