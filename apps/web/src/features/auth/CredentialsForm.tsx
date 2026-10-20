'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { loginSchema, registerSchema } from '@trao/contracts';
import { Alert } from '../../components/ui/Alert';
import { Button } from '../../components/ui/Button';
import { TextField } from '../../components/ui/TextField';
import { useAuth } from '../../lib/auth/AuthProvider';
import {
  describeAuthError,
  fieldErrorsFromIssues,
  type AuthFailure,
  type AuthMode,
  type FieldErrors,
} from './errors';

type FocusTarget = 'email' | 'password' | 'form' | null;

const COPY = {
  login: {
    heading: 'Sign in',
    submit: 'Sign in',
    submitting: 'Signing in…',
    passwordAutocomplete: 'current-password',
    switchText: 'New here?',
    switchLink: 'Create an account',
    switchHref: '/register',
  },
  register: {
    heading: 'Create your account',
    submit: 'Create account',
    submitting: 'Creating account…',
    passwordAutocomplete: 'new-password',
    switchText: 'Already have an account?',
    switchLink: 'Sign in',
    switchHref: '/login',
  },
} as const;

/**
 * One form for both sign-in and registration: the checks are the API's own schemas (so the browser and
 * the server cannot disagree), the messages are our own wording, a failed attempt moves keyboard focus to
 * the first thing to fix, and the button is disabled while a request is in flight.
 */
export function CredentialsForm({ mode, notice }: { mode: AuthMode; notice?: string | undefined }) {
  const copy = COPY[mode];
  const auth = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [failure, setFailure] = useState<AuthFailure>({ fields: {} });
  const [submitting, setSubmitting] = useState(false);
  const [focusTarget, setFocusTarget] = useState<FocusTarget>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!focusTarget) return;
    const target =
      focusTarget === 'email'
        ? emailRef.current
        : focusTarget === 'password'
          ? passwordRef.current
          : alertRef.current;
    target?.focus();
    setFocusTarget(null);
  }, [focusTarget]);

  function showFailure(next: AuthFailure) {
    setFailure(next);
    setFocusTarget(next.fields.email ? 'email' : next.fields.password ? 'password' : 'form');
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    const parsed = (mode === 'login' ? loginSchema : registerSchema).safeParse({ email, password });
    if (!parsed.success) {
      showFailure({ fields: fieldErrorsFromIssues(parsed.error.issues, mode) });
      return;
    }
    setFailure({ fields: {} });
    setSubmitting(true);
    try {
      if (mode === 'login') await auth.login(parsed.data);
      else await auth.register(parsed.data);
      // Success: the auth state changes and the page around this form moves the user on.
    } catch (error) {
      showFailure(describeAuthError(error, mode));
      setSubmitting(false);
    }
  }

  const fields: FieldErrors = failure.fields;
  return (
    <form onSubmit={onSubmit} noValidate aria-labelledby="auth-heading" className="space-y-5">
      <h1 id="auth-heading" className="text-2xl font-semibold text-slate-900">
        {copy.heading}
      </h1>
      {notice ? <Alert tone="info">{notice}</Alert> : null}
      {failure.form ? (
        <Alert tone="error" ref={alertRef}>
          {failure.form}
        </Alert>
      ) : null}
      <TextField
        ref={emailRef}
        label="Email"
        name="email"
        type="email"
        autoComplete="email"
        inputMode="email"
        autoCapitalize="none"
        spellCheck={false}
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        error={fields.email}
      />
      <TextField
        ref={passwordRef}
        label="Password"
        name="password"
        type="password"
        autoComplete={copy.passwordAutocomplete}
        required
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        error={fields.password}
        {...(mode === 'register'
          ? { hint: 'At least 10 characters. A few random words work well.' }
          : {})}
      />
      <Button type="submit" loading={submitting} className="w-full">
        {submitting ? copy.submitting : copy.submit}
      </Button>
      <p className="text-sm text-slate-700">
        {copy.switchText}{' '}
        <Link
          href={copy.switchHref}
          className="font-medium text-indigo-800 underline underline-offset-2"
        >
          {copy.switchLink}
        </Link>
      </p>
    </form>
  );
}
