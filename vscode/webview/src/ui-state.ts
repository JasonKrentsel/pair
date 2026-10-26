import type { Change, Conversation, DecisionIdentity, PairState, Review } from './types';

type IdentitySource = Review | Conversation | DecisionIdentity | undefined;
export const identityOf = (value: IdentitySource): DecisionIdentity | undefined => {
  if (!value) return;
  if ('identity' in value && value.identity) return value.identity;
  return { reviewId: 'reviewId' in value ? value.reviewId : value.id, revision: value.revision, fingerprint: value.fingerprint, gate: value.gate };
};

export function sameIdentity(review: IdentitySource, value: IdentitySource) {
  const left = identityOf(review), right = identityOf(value);
  return !!left && !!right && left.reviewId === right.reviewId && left.revision === right.revision
    && left.fingerprint === right.fingerprint && (left.gate ?? 1) === (right.gate ?? 1);
}

export function actionLabel(change: Change | undefined) {
  if (typeof change?.command === 'string') {
    return change.command.split(/\r?\n/).map(line => line.trim()).filter(Boolean)[0]?.replace(/^(?:#|\/\/)\s*/, '') || 'Run command';
  }
  return String(change?.label || 'Selected file').replace(/\\/g, '/').split('/').at(-1) || 'Selected file';
}

export function reviewStatus(state: PairState) {
  if (!state.connected) return { label: 'Disconnected', tone: 'muted', title: 'Connect to Pi' };
  if (!state.review) return { label: 'Connected', tone: 'success', title: 'Ready for the next step' };
  if (state.review.pending) return { label: 'Needs approval', tone: 'pending', title: 'Ready to review' };
  if (/^Applying /.test(state.review.status || '')) return { label: 'Running', tone: 'running', title: 'Step in progress' };
  if (state.review.status === 'Applied') return { label: 'Completed', tone: 'success', title: 'Step complete' };
  if (/fail|error|interrupted/i.test(state.review.status || '')) return { label: state.review.status, tone: 'error', title: 'Needs attention' };
  return { label: state.review.status || 'Saved step', tone: 'muted', title: 'Step history' };
}

export function permissionBlocker(state: PairState) {
  if (!state.connected) return state.session ? 'Reconnect to Pi to continue reviewing this step.' : '';
  if (!state.trusted) return 'Trust this workspace to approve or deny a step.';
  if (state.alteredSnapshots) return 'A review snapshot changed. Close its diff and reopen it before approving.';
  if (state.dirtyFiles?.length) return `Save or discard unsaved changes in ${state.dirtyFiles.join(', ')} before approving.`;
  return '';
}

export type LocalState = {
  review?: { key: string; selection: number; scroll: number; details: Record<number, boolean> };
  conversationDrafts?: Record<string, { draft: string; scroll: number; following: boolean }>;
  [key: string]: unknown;
};
