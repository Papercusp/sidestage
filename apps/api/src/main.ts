import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors();
  const port = Number(process.env.API_PORT ?? 3100);
  await app.listen(port, '0.0.0.0');
}

void bootstrap();
