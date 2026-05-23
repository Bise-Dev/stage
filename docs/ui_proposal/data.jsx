/* data.jsx — sample content shared across both directions */

const WORKSPACES = [
  {
    id: 'feat-checkout-v2',
    branch: 'feat/checkout-v2',
    title: 'Replace legacy checkout with multi-step flow',
    author: 'You',
    state: 'in-review',
    base: 'main',
    ahead: 14, behind: 2,
    added: 412, removed: 87,
    files: 11,
    updated: 'just now',
    comments: 6,
    storyline: 7,
    reviewers: ['Mira Park', 'Jon Singh'],
  },
  {
    id: 'fix-stripe-webhook',
    branch: 'fix/stripe-webhook-retry',
    title: 'Idempotent retries for Stripe webhook handler',
    author: 'You',
    state: 'draft',
    base: 'main',
    ahead: 3, behind: 0,
    added: 64, removed: 22,
    files: 4,
    updated: '12 min ago',
    comments: 0,
    storyline: 0,
    reviewers: [],
  },
  {
    id: 'mira-dashboard-perf',
    branch: 'mira/dashboard-perf',
    title: 'Memoize dashboard widgets; drop redundant fetches',
    author: 'Mira Park',
    state: 'reviewing',
    base: 'main',
    ahead: 6, behind: 1,
    added: 138, removed: 96,
    files: 8,
    updated: '2h ago',
    comments: 3,
    storyline: 5,
    reviewers: ['You', 'Sam Okafor'],
  },
  {
    id: 'jon-sso-okta',
    branch: 'jon/sso-okta',
    title: 'Okta SSO provider behind feature flag',
    author: 'Jon Singh',
    state: 'requested',
    base: 'main',
    ahead: 22, behind: 4,
    added: 731, removed: 14,
    files: 19,
    updated: 'yesterday',
    comments: 11,
    storyline: 9,
    reviewers: ['You'],
  },
  {
    id: 'sam-empty-states',
    branch: 'sam/empty-states-polish',
    title: 'Empty state illustrations + copy pass',
    author: 'Sam Okafor',
    state: 'approved',
    base: 'main',
    ahead: 4, behind: 0,
    added: 92, removed: 38,
    files: 6,
    updated: 'Mon',
    comments: 2,
    storyline: 3,
    reviewers: ['You', 'Mira Park'],
  },
];

/* Files inside the active workspace (feat/checkout-v2). */
const FILES = [
  { path: 'src/checkout/CheckoutFlow.tsx',           add: 142, del: 8,  status: 'modified', viewed: true,  comments: 3 },
  { path: 'src/checkout/steps/AddressStep.tsx',      add: 96,  del: 0,  status: 'added',    viewed: true,  comments: 0 },
  { path: 'src/checkout/steps/PaymentStep.tsx',      add: 84,  del: 0,  status: 'added',    viewed: false, comments: 2 },
  { path: 'src/checkout/steps/ReviewStep.tsx',       add: 52,  del: 0,  status: 'added',    viewed: false, comments: 0 },
  { path: 'src/checkout/state.ts',                   add: 28,  del: 12, status: 'modified', viewed: false, comments: 1 },
  { path: 'src/api/orders.ts',                       add: 6,   del: 14, status: 'modified', viewed: false, comments: 0 },
  { path: 'src/components/Button.tsx',               add: 4,   del: 3,  status: 'modified', viewed: false, comments: 0 },
  { path: 'tests/checkout.spec.ts',                  add: 0,   del: 30, status: 'removed',  viewed: false, comments: 0 },
  { path: 'tests/checkout/flow.spec.ts',             add: 0,   del: 0,  status: 'renamed',  viewed: false, comments: 0, from: 'tests/old-checkout.spec.ts' },
  { path: 'Dockerfile',                              add: 8,   del: 0,  status: 'modified', viewed: false, comments: 0 },
  { path: 'README.md',                               add: 2,   del: 2,  status: 'modified', viewed: false, comments: 0 },
];

/* Sample diff (PaymentStep.tsx). */
const DIFF_PAYMENT = [
  { kind: 'hunk', text: '@@ -1,4 +1,14 @@ src/checkout/steps/PaymentStep.tsx' },
  { kind: 'ctx', n1: 1,  n2: 1,  text: 'import { useState } from "react";' },
  { kind: 'ctx', n1: 2,  n2: 2,  text: 'import { Button } from "../../components/Button";' },
  { kind: 'add', n2: 3,           text: 'import { useCheckout } from "../state";' },
  { kind: 'add', n2: 4,           text: 'import { StripeElement } from "../stripe";' },
  { kind: 'ctx', n1: 3,  n2: 5,  text: '' },
  { kind: 'ctx', n1: 4,  n2: 6,  text: 'export function PaymentStep() {' },
  { kind: 'add', n2: 7,           text: '  const { state, dispatch } = useCheckout();' },
  { kind: 'add', n2: 8,           text: '  const [submitting, setSubmitting] = useState(false);' },
  { kind: 'add', n2: 9,           text: '' },
  { kind: 'add', n2: 10,          text: '  async function onSubmit() {' },
  { kind: 'add', n2: 11,          text: '    setSubmitting(true);' },
  { kind: 'add', n2: 12,          text: '    const token = await StripeElement.tokenize(state.card);' },
  { kind: 'add', n2: 13,          text: '    dispatch({ type: "PAYMENT_TOKEN", token });' },
  { kind: 'add', n2: 14,          text: '  }' },
  { kind: 'add', n2: 15,          text: '' },
  { kind: 'ctx', n1: 5,  n2: 16, text: '  return (' },
  { kind: 'ctx', n1: 6,  n2: 17, text: '    <form>' },
];

const DIFF_DOCKERFILE = [
  { kind: 'hunk', text: '@@ -15,6 +15,14 @@ COPY . /app' },
  { kind: 'ctx', n1: 15, n2: 15, text: 'RUN --mount=type=cache,target=/root/.cache/uv \\' },
  { kind: 'ctx', n1: 16, n2: 16, text: '    uv sync --frozen --no-dev' },
  { kind: 'ctx', n1: 17, n2: 17, text: '' },
  { kind: 'add', n2: 18,         text: '# Build-time settings: dummy values so collectstatic can import settings' },
  { kind: 'add', n2: 19,         text: '# without requiring real secrets/db. Production env vars come in at runtime.' },
  { kind: 'add', n2: 20,         text: 'ENV DJANGO_SECRET_KEY=build-time-placeholder \\' },
  { kind: 'add', n2: 21,         text: '    DJANGO_DEBUG=False \\' },
  { kind: 'add', n2: 22,         text: '    DJANGO_SETTINGS_MODULE=config.settings.production \\' },
  { kind: 'add', n2: 23,         text: '    POSTGRES_HOST=localhost' },
  { kind: 'add', n2: 24,         text: 'RUN .venv/bin/python manage.py collectstatic --noinput' },
  { kind: 'add', n2: 25,         text: '' },
  { kind: 'ctx', n1: 18, n2: 26, text: 'FROM python:3.13-slim-bookworm AS runtime' },
];

/* Storyline — the author's ordered walkthrough for reviewers. */
const STORYLINE = [
  { step: 1, file: 'src/checkout/state.ts',                title: 'New checkout state machine',          intro: 'Start here — this is the heart of the change. The reducer drives every step.' },
  { step: 2, file: 'src/checkout/CheckoutFlow.tsx',        title: 'Routing between steps',               intro: 'Replaces the old single-form component. Stepper UI is unchanged from the spec.' },
  { step: 3, file: 'src/checkout/steps/AddressStep.tsx',   title: 'Step 1 — address',                    intro: 'Mostly lifted from the old form. New: country-aware postal validation.' },
  { step: 4, file: 'src/checkout/steps/PaymentStep.tsx',   title: 'Step 2 — payment',                    intro: 'Stripe Elements tokenization. We never touch raw card numbers.' },
  { step: 5, file: 'src/checkout/steps/ReviewStep.tsx',    title: 'Step 3 — review & submit',            intro: 'Final confirm. Calls the existing orders API.' },
  { step: 6, file: 'src/api/orders.ts',                    title: 'Order payload changes',               intro: 'Adds the tokenized payment field; removes the legacy `cc` blob.' },
  { step: 7, file: 'Dockerfile',                           title: 'Build-time env shim',                  intro: 'Unrelated but blocking: collectstatic needed dummy settings to load. Happy to split this off.' },
];

const COMMENTS = {
  'PaymentStep:12': {
    author: 'Mira Park',
    when: '14m',
    text: 'Should we set a timeout on `tokenize`? On flaky networks this just hangs and the button stays in `submitting`. A 10s abort with a friendly error would match what `orders.ts` does.',
    replies: [
      { author: 'You', when: '5m', text: 'Good catch. I\'ll wrap it with `AbortController` and surface the error through the form state.' },
    ],
  },
  'state:28': {
    author: 'Jon Singh',
    when: '32m',
    text: 'Naming nit: `dispatch({ type: "PAYMENT_TOKEN" })` reads as the event, not the action. `STORE_PAYMENT_TOKEN` matches the rest of the file.',
  },
};

Object.assign(window, { WORKSPACES, FILES, DIFF_PAYMENT, DIFF_DOCKERFILE, STORYLINE, COMMENTS });
