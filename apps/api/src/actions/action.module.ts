import { Module } from '@nestjs/common';
import { ActionController } from './action.controller';
import { GuardedActionService } from './action.service';

@Module({
  controllers: [ActionController],
  providers: [GuardedActionService],
  exports: [GuardedActionService],
})
export class ActionModule {}
