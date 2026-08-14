import {
  Inject,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
} from '@nestjs/common';
import {
  ChatService,
  type ChatMessageInput,
  type PresenceInput,
  type TranscriptMomentInput,
} from './chat.service';

@Controller()
export class ChatController {
  constructor(@Inject(ChatService) private readonly chat: ChatService) {}

  @Post('chat/events/:eventId/messages')
  sendMessage(@Param('eventId') eventId: string, @Body() body: ChatMessageInput) {
    return this.chat.addMessage(eventId, body ?? {});
  }

  @Post('chat/events/:eventId/transcript')
  addTranscriptMoment(@Param('eventId') eventId: string, @Body() body: TranscriptMomentInput) {
    return this.chat.addTranscriptMoment(eventId, body ?? {});
  }

  @Post('chat/events/:eventId/presence')
  joinPresence(@Param('eventId') eventId: string, @Body() body: PresenceInput) {
    return this.chat.touchPresence(eventId, body ?? {});
  }

  @Delete('chat/events/:eventId/presence/:userId')
  leavePresence(@Param('eventId') eventId: string, @Param('userId') userId: string) {
    this.chat.removePresence(eventId, userId);
    return { ok: true };
  }

  @Get('chat/events/:eventId/presence')
  getPresence(@Param('eventId') eventId: string) {
    return this.chat.getPresence(eventId);
  }
}
