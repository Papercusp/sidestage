import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CopilotReplyReview, sellerReplyRequest } from './CopilotPanel';

describe('seller copilot reply review', () => {
  it('builds an approved reply as a real seller chat mutation', () => {
    const request = sellerReplyRequest('event/one', '  Edited reply  ');
    expect(request.path).toBe('/chat/events/event%2Fone/messages');
    expect(request.init.method).toBe('POST');
    expect(JSON.parse(String(request.init.body))).toEqual({
      userId: 'seller-copilot-review',
      displayName: 'Host',
      role: 'seller',
      text: 'Edited reply',
    });
  });

  it('renders the approve, edit, and skip review actions', () => {
    const markup = renderToStaticMarkup(
      <CopilotReplyReview
        draft="The mug is dishwasher safe."
        editing={false}
        status="pending"
        onDraftChange={() => undefined}
        onEdit={() => undefined}
        onApprove={() => undefined}
        onSkip={() => undefined}
      />,
    );
    expect(markup).toContain('data-copilot-reply-review="true"');
    expect(markup).toContain('Approve');
    expect(markup).toContain('Edit');
    expect(markup).toContain('Skip');
  });
});
