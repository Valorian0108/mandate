// Gate #2 (the toy): a files gate.
//
// This exists to prove Layer C's "done when": a SECOND, DIFFERENT gate plugs into
// the engine without changing the core. It has its own namespace, its own actions,
// its own policy fields - nothing in engine.mjs knows it exists.
//
// There is no on-chain lock for this domain yet, so it is honestly marked
// advisoryOnly: its verdicts are the company-side decision only.

function deny(code, reason) {
  return { verdict: 'DENY', code, reason };
}

const POLICY_FIELDS = ['protectedPaths', 'maxDeletesPerDay', 'deletesToday', 'shareRequiresApproval'];

export const filesGateDocument = {
  version: 1,
  namespace: 'files',
  description: 'Toy gate: which folders the agent may delete from or share, and how many deletes per day.',
  actions: ['files:delete', 'files:share'],
  contextFields: {
    'files:delete': [{ name: 'path', type: 'string', required: true }],
    'files:share': [],
  },
  policyFields: POLICY_FIELDS,
  codes: [
    'no-policy', 'incomplete-context', 'protected-path',
    'daily-limit', 'approval-required', 'within-mandate',
  ],
  approvals: {
    canAskUser: true,
    resolutions: ['execute-once', 'decline'],
  },
  advisoryOnly: true,
};

export const filesGate = {
  namespace: 'files',
  actions: ['files:delete', 'files:share'],
  policyFields: POLICY_FIELDS,
  advisoryOnly: true, // no Layer E lock for this domain yet - engine decision only.
  document: filesGateDocument,

  evaluate(request, policy) {
    if (!policy) {
      return deny('no-policy', 'no files policy is set for this user - denied by default');
    }
    const ctx = request.context ?? {};

    if (request.action === 'files:delete') {
      const path = String(ctx.path ?? '');
      if (!path) return deny('incomplete-context', 'a files:delete request needs a path');
      for (const protectedPath of policy.protectedPaths ?? []) {
        if (path === protectedPath || path.startsWith(protectedPath.replace(/\/$/, '') + '/')) {
          return deny('protected-path',
            `'${path}' is inside the protected folder '${protectedPath}'`);
        }
      }
      const used = Number(policy.deletesToday ?? 0);
      const max = Number(policy.maxDeletesPerDay ?? 0);
      if (used >= max) {
        return deny('daily-limit', `the daily delete limit (${max}) is used up`);
      }
      return {
        verdict: 'ALLOW',
        code: 'within-mandate',
        reason: `'${path}' is not protected and ${used}/${max} deletes are used today`,
      };
    }

    // files:share - demonstrates ASK_USER: some actions are never auto-allowed.
    if (policy.shareRequiresApproval) {
      return {
        verdict: 'ASK_USER',
        code: 'approval-required',
        reason: 'sharing files always needs the user to approve this specific share',
      };
    }
    return { verdict: 'ALLOW', code: 'within-mandate', reason: 'sharing is allowed by policy' };
  },
};
