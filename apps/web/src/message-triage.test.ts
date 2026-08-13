import { describe, expect, it } from 'vitest';
import { classifyMessageImportance, triageMessages } from './message-triage';

describe('message triage', () => {
  it('prioritizes buyer questions and purchase intent', () => {
    expect(classifyMessageImportance('Is the Aurora cup still available?')).toMatchObject({
      importance: 'high',
      label: 'Priority',
    });
    expect(classifyMessageImportance('Can I get this in a larger size')).toMatchObject({ importance: 'high' });
  });

  it('keeps social reactions out of the focused queue', () => {
    expect(classifyMessageImportance('Love this drop!')).toMatchObject({
      importance: 'low',
      label: 'Social',
    });
    expect(classifyMessageImportance('The blue one would look great in my kitchen.')).toMatchObject({ importance: 'normal' });
  });

  it('preserves message identity while attaching triage metadata', () => {
    const messages = [{ id: 'm-1', text: 'What is the price?' }, { id: 'm-2', text: 'Thanks!' }];
    expect(triageMessages(messages)).toEqual([
      { message: messages[0], triage: { importance: 'high', label: 'Priority', reason: 'Direct question' } },
      { message: messages[1], triage: { importance: 'low', label: 'Social', reason: 'Social reaction' } },
    ]);
  });
});
