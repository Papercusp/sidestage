import { Module } from '@nestjs/common';
import { EventConfigModule } from '../config/event-config.module';
import { ActionController } from './action.controller';
import { GuardedActionService } from './action.service';

@Module({
  imports: [EventConfigModule],
  controllers: [ActionController],
  providers: [GuardedActionService],
  exports: [GuardedActionService],
})
export class ActionModule {}
