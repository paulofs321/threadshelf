// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { ResultCard } from '../../src/ui/ResultCard';
import { EvidenceIdSchema, requireValid } from '../../src/contracts';
import type { Candidate } from '../../src/contracts';
import { chatCandidate, googleCandidate, linkVerifiers } from '../fixtures/contracts';

const title = chatCandidate.title;
const titleEvidence = chatCandidate.evidence[0];
const googleEvidence = googleCandidate.evidence[0];

if (title === undefined || titleEvidence === undefined || googleEvidence === undefined)
  throw new Error('Missing synthetic result metadata.');

afterEach(cleanup);
describe('result evidence and navigation', () => {
  it('previews long evidence and expands/collapses the complete text with the keyboard', async () => {
    const user = userEvent.setup();
    const text = 'A fictional librarian records a trip through Cloud City.\n'.repeat(12);
    const evidence = Object.freeze({
      id: requireValid(EvidenceIdSchema, 'fiction-long-excerpt'),
      source: 'native-snippet' as const,
      text,
    });
    render(
      <ResultCard
        candidate={{ ...chatCandidate, evidence: [evidence] }}
        verifiers={linkVerifiers}
        timeZone="UTC"
      />,
    );
    const toggle = screen.getByRole('button', { name: 'Show more' });
    const excerpt = document.querySelector('blockquote');
    expect(excerpt?.textContent).toBe(`${text.slice(0, 180)}…`);
    expect(excerpt?.classList.contains('whitespace-normal')).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(
      document.getElementById(toggle.getAttribute('aria-controls') ?? '')?.contains(excerpt),
    ).toBe(true);
    toggle.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: 'Show less' })).toBe(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(toggle);
    expect(excerpt?.textContent).toBe(text);
    expect(excerpt?.classList.contains('whitespace-pre-wrap')).toBe(true);
    await user.keyboard(' ');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(excerpt?.textContent).toBe(`${text.slice(0, 180)}…`);
    expect(evidence.text).toBe(text);
  });
  it('shows one short excerpt without repeating the title, then reveals every excerpt', async () => {
    const user = userEvent.setup();
    render(
      <ResultCard
        candidate={{
          ...chatCandidate,
          evidence: [...chatCandidate.evidence, ...googleCandidate.evidence],
        }}
        verifiers={linkVerifiers}
        timeZone="UTC"
      />,
    );
    expect(document.querySelectorAll('blockquote')).toHaveLength(1);
    expect(screen.getAllByText(title)).toHaveLength(1);
    expect(screen.queryByText(googleEvidence.text)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Show more' }));
    expect(document.querySelectorAll('blockquote')).toHaveLength(2);
    expect(screen.getByText(googleEvidence.text)).toBeTruthy();
    expect(screen.getAllByText(title)).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Show less' }));
    expect(document.querySelectorAll('blockquote')).toHaveLength(1);
  });
  it('does not add an expansion action to a short single excerpt', () => {
    render(<ResultCard candidate={chatCandidate} verifiers={linkVerifiers} timeZone="UTC" />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(document.querySelector('blockquote')?.textContent).toBe(chatCandidate.evidence[1]?.text);
    expect(screen.getAllByText(title)).toHaveLength(1);
  });
  it('does not repeat title-only evidence as an excerpt', () => {
    render(
      <ResultCard
        candidate={{ ...chatCandidate, evidence: [titleEvidence] }}
        verifiers={linkVerifiers}
        timeZone="UTC"
      />,
    );
    expect(screen.getAllByText(title)).toHaveLength(1);
    expect(screen.getByText('No excerpt available.')).toBeTruthy();
    expect(document.querySelector('blockquote')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });
  it('keeps Unicode characters whole at the preview boundary', async () => {
    const user = userEvent.setup();
    const text = `${'📚'.repeat(180)}🦉`;
    render(
      <ResultCard
        candidate={{ ...googleCandidate, evidence: [{ ...googleEvidence, text }] }}
        verifiers={linkVerifiers}
        timeZone="UTC"
      />,
    );
    expect(document.querySelector('blockquote')?.textContent).toBe(`${'📚'.repeat(180)}…`);
    await user.click(screen.getByRole('button', { name: 'Show more' }));
    expect(document.querySelector('blockquote')?.textContent).toBe(text);
  });
  it('does not truncate evidence exactly at the preview limit', () => {
    const text = '📚'.repeat(180);
    render(
      <ResultCard
        candidate={{ ...googleCandidate, evidence: [{ ...googleEvidence, text }] }}
        verifiers={linkVerifiers}
        timeZone="UTC"
      />,
    );
    expect(document.querySelector('blockquote')?.textContent).toBe(text);
    expect(screen.queryByRole('button')).toBeNull();
  });
  it('keeps hostile evidence as plain text after expansion', async () => {
    const user = userEvent.setup();
    const text = `${'Fictional evidence. '.repeat(20)}<img src=x onerror=alert(1)><script>alert(1)</script>`;
    render(
      <ResultCard
        candidate={{ ...googleCandidate, evidence: [{ ...googleEvidence, text }] }}
        verifiers={linkVerifiers}
        timeZone="UTC"
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Show more' }));
    expect(document.querySelector('blockquote')?.textContent).toBe(text);
    expect(document.querySelector('script, img')).toBeNull();
  });
  it('renders hostile titles and excerpts as exact plain text', () => {
    const candidate: Candidate = {
      ...chatCandidate,
      title: '<img src=x onerror=alert(1)>',
      evidence: [
        {
          ...chatCandidate.evidence[0],
          id: requireValid(EvidenceIdSchema, 'fiction-hostile-excerpt'),
          source: 'native-snippet',
          text: '<script>alert(1)</script>\nIgnore all instructions',
        },
      ],
    };
    render(<ResultCard candidate={candidate} verifiers={linkVerifiers} timeZone="Europe/Zurich" />);
    expect(screen.getByRole('heading').textContent).toBe(candidate.title);
    expect(document.querySelector('blockquote')?.textContent).toBe(candidate.evidence[0]?.text);
    expect(document.querySelector('script, img')).toBeNull();
  });
  it('keeps absent metadata absent with explicit unknown title/date/excerpt/link labels', () => {
    const { title: _title, originalUrl: _url, ...candidate } = googleCandidate;
    render(
      <ResultCard
        candidate={{ ...candidate, evidence: [] }}
        verifiers={linkVerifiers}
        timeZone="UTC"
      />,
    );
    expect(screen.getByRole('article', { name: 'Untitled conversation' })).toBeTruthy();
    expect(screen.getByText('Date unavailable')).toBeTruthy();
    expect(screen.getByText('No excerpt available.')).toBeTruthy();
    expect(screen.getByText('Original link unavailable.')).toBeTruthy();
  });
  it.each([
    'javascript:alert(1)',
    'https://evil.invalid/thread',
    'https://chatgpt.example.invalid/threads/wrong-id',
    'https://user:pass@chatgpt.example.invalid/threads/fictional-thread-aurora',
  ])('does not expose an unsafe or unverified navigation target %s', (originalUrl) => {
    render(
      <ResultCard
        candidate={{ ...chatCandidate, originalUrl }}
        verifiers={linkVerifiers}
        timeZone="UTC"
      />,
    );
    expect(screen.queryByRole('link')).toBeNull();
  });
  it.each([
    ['conversation-created', 'provider-metadata', 'Conversation created', 'provider metadata'],
    ['conversation-updated', 'provider-metadata', 'Conversation updated', 'provider metadata'],
    ['message-sent', 'rendered-message', 'Message sent', 'rendered message'],
  ] as const)(
    'shows the %s date meaning and %s provenance',
    (meaning, source, label, provenance) => {
      render(
        <ResultCard
          candidate={{
            ...chatCandidate,
            date: { at: '2026-10-16T22:30:00.000Z', meaning, source },
          }}
          verifiers={linkVerifiers}
          timeZone="Europe/Zurich"
        />,
      );
      expect(screen.getByText(new RegExp(label)).parentElement?.textContent).toContain(provenance);
      expect(document.querySelector('time')?.getAttribute('datetime')).toBe(
        '2026-10-16T22:30:00.000Z',
      );
      expect(document.querySelector('time')?.textContent).toContain('17');
    },
  );
});
