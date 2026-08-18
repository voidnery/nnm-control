import { useI18n } from '../i18n.jsx';

// Turning a failure code into a sentence, and never into a raw key.
//
// This is a switch of literal `t('...')` calls rather than
// `t('llhls.confError.' + code)`, and that is deliberate on two counts.
//
// A computed key renders as itself when the string is missing. That is what
// shipped: a Russian interface displayed
// `llhls.confError.agent is not enabled for this server` — the code path took
// an exception's English message, treated it as a key suffix, found nothing,
// and printed the whole thing.
//
// And a computed key is invisible to the i18n audit, which reads static
// `t('literal')` calls. Written this way every string is checked in both
// dictionaries on every run, so the missing one fails a build instead of
// reaching a screenshot. Verbose, and the verbosity is the check.
//
// `backend/tests/error-codes.test.mjs` holds this set equal to the codes the
// API can actually return.

export function confErrorText(t, code) {
  switch (code) {
    case 'agent-disabled': return t('llhls.confError.agent-disabled');
    case 'agent-offline': return t('llhls.confError.agent-offline');
    case 'agent-timeout': return t('llhls.confError.agent-timeout');
    case 'agent-too-old': return t('llhls.confError.agent-too-old');
    case 'nimble-conf-missing': return t('llhls.confError.nimble-conf-missing');
    case 'nimble-conf-unreadable': return t('llhls.confError.nimble-conf-unreadable');
    // Including a code this build has never heard of. An interface that meets
    // one should say something true rather than print it.
    default: return t('llhls.confError.unknown');
  }
}

export function confErrorFix(t, code) {
  switch (code) {
    case 'agent-disabled': return t('llhls.confFix.agent-disabled');
    case 'agent-offline': return t('llhls.confFix.agent-offline');
    case 'agent-timeout': return t('llhls.confFix.agent-timeout');
    case 'agent-too-old': return t('llhls.confFix.agent-too-old');
    case 'nimble-conf-missing': return t('llhls.confFix.nimble-conf-missing');
    case 'nimble-conf-unreadable': return t('llhls.confFix.nimble-conf-unreadable');
    default: return t('llhls.confFix.unknown');
  }
}

// What it is, what to do, and — small and last — what the machine actually
// said. The detail is worth having and is not an explanation; putting it first
// is how an operator ends up reading an exception instead of an instruction.
export default function ConfError({ code, detail }) {
  const { t } = useI18n();
  if (!code) return null;
  return (
    <div className="error-box">
      <b>{confErrorText(t, code)}</b>
      <div>{confErrorFix(t, code)}</div>
      {detail && <div className="hint mono">{detail}</div>}
    </div>
  );
}
