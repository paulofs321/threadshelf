import { useId, useState } from 'react';
import { acceptsOriginalLink, OriginalUrlSchema, validate } from '../contracts';
import type { Candidate, LinkVerifiers } from '../contracts';
import { providerLabels } from './SetupScreen';
import { Icon } from './Icon';
import { Badge } from './components/badge';
import { Button } from './components/button';
import { Card, CardContent, CardHeader } from './components/card';

const dateLabels = {
  'conversation-created': 'Conversation created',
  'conversation-updated': 'Conversation updated',
  'message-sent': 'Message sent',
};
const sources = {
  'provider-metadata': 'provider metadata',
  'rendered-message': 'rendered message',
};

export function ResultCard({
  candidate,
  verifiers,
  timeZone,
}: {
  candidate: Candidate;
  verifiers: LinkVerifiers;
  timeZone: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const excerptsId = useId();
  const excerpts = candidate.evidence.filter((evidence) => evidence.source !== 'title');
  const preview = excerpts[0];
  const previewText = preview ? Array.from(preview.text).slice(0, 180).join('') : '';
  const shortened = preview !== undefined && previewText.length < preview.text.length;
  const expandable = shortened || excerpts.length > 1;
  const link =
    validate(OriginalUrlSchema, candidate.originalUrl).ok &&
    acceptsOriginalLink(candidate, verifiers);

  return (
    <Card
      className="min-w-0 rounded-xl shadow-none transition-colors hover:border-primary/35 hover:bg-accent/45 focus-within:border-primary/50"
      role="article"
      aria-label={candidate.title ?? 'Untitled conversation'}
    >
      <CardHeader className="space-y-2 p-3 pb-2">
        <div className="flex items-center justify-between gap-2">
          <Badge
            variant="secondary"
            className={`max-w-full gap-1.5 border-0 bg-transparent p-0 text-xs whitespace-normal ${candidate.scope.provider === 'chatgpt' ? 'text-[#12816b]' : 'text-[#4468b9]'}`}
          >
            <span
              className={`flex size-6 shrink-0 items-center justify-center rounded-md ${candidate.scope.provider === 'chatgpt' ? 'bg-[#eaf5f0]' : 'bg-[#eef3fc]'}`}
            >
              {candidate.scope.provider === 'chatgpt' ? (
                <Icon name="chat" className="size-4" />
              ) : (
                <span className="text-base font-bold" aria-hidden="true">
                  G
                </span>
              )}
            </span>
            {candidate.scope.provider === 'chatgpt'
              ? providerLabels[candidate.scope.provider]
              : 'Google AI Mode'}
          </Badge>
          <p className="shrink-0 text-right text-xs text-muted-foreground">
            {candidate.date ? (
              <>
                <span className="sr-only">{dateLabels[candidate.date.meaning]}: </span>
                <time
                  dateTime={candidate.date.calendarDay?.date ?? candidate.date.at}
                  title={
                    candidate.date.calendarDay
                      ? candidate.date.calendarDay.basis === 'time-only-today'
                        ? 'Time-only label; used the local date when read'
                        : 'Message date shown in the conversation (day precision)'
                      : undefined
                  }
                >
                  {new Intl.DateTimeFormat(undefined, {
                    dateStyle: 'medium',
                    timeZone: candidate.date.calendarDay?.timeZone ?? timeZone,
                  }).format(new Date(candidate.date.at))}
                </time>{' '}
                <span className="sr-only">({sources[candidate.date.source]})</span>
              </>
            ) : (
              'Date unavailable'
            )}
          </p>
        </div>
        <div className="flex items-start justify-between gap-2">
          <h3 className="min-w-0 text-base font-semibold leading-snug">
            {candidate.title ?? 'Untitled conversation'}
          </h3>
          {link && (
            <Button
              asChild
              variant="ghost"
              size="icon"
              className="size-6 shrink-0 p-0 text-primary"
            >
              <a
                href={candidate.originalUrl}
                target="_blank"
                rel="noopener noreferrer"
                referrerPolicy="no-referrer"
              >
                <Icon name="open" className="size-4" />
                <span className="sr-only">Open original conversation (opens in a new tab)</span>
              </a>
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-2 p-3 pt-0">
        {excerpts.length === 0 ? (
          <p className="text-sm text-muted-foreground">No excerpt available.</p>
        ) : (
          <div id={excerptsId} className="space-y-2">
            {(expanded ? excerpts : excerpts.slice(0, 1)).map((evidence) => (
              <blockquote
                key={evidence.id}
                className={`${expanded ? 'whitespace-pre-wrap' : 'whitespace-normal'} text-sm leading-relaxed text-muted-foreground`}
              >
                {expanded ? evidence.text : previewText}
                {!expanded && shortened && <span aria-hidden="true">…</span>}
              </blockquote>
            ))}
          </div>
        )}
        {expandable && (
          <Button
            type="button"
            variant="ghost"
            className="min-h-7 px-0 py-0 text-xs text-primary"
            aria-expanded={expanded}
            aria-controls={excerptsId}
            onClick={() => setExpanded((previous) => !previous)}
          >
            {expanded ? 'Show less' : 'Show more'}
          </Button>
        )}
        {!link && <p className="text-xs text-muted-foreground">Original link unavailable.</p>}
      </CardContent>
    </Card>
  );
}
