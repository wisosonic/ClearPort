import { Controller, Get, Inject } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.module';
import { Public } from '../auth/decorators';

@Controller('health')
export class HealthController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  @Public()
  @Get()
  async health() {
    await this.prisma.client.$queryRaw`SELECT 1`;
    return { status: 'ok' };
  }
}
