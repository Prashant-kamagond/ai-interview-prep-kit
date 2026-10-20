import { describe, expect, it } from 'vitest';
import * as login from './(auth)/login/page';
import * as register from './(auth)/register/page';
import * as kits from './(app)/kits/page';
import * as create from './(app)/kits/new/page';
import * as editor from './(app)/kits/[id]/page';
import * as practice from './(app)/kits/[id]/practice/page';

describe('every page has its own title, so a screen reader announces where you are', () => {
  it('names each page', () => {
    expect(login.metadata.title).toBe('Sign in');
    expect(register.metadata.title).toBe('Create account');
    expect(kits.metadata.title).toBe('Your kits');
    expect(create.metadata.title).toBe('Create a kit');
    expect(editor.metadata.title).toBe('Edit kit');
    expect(practice.metadata.title).toBe('Practise flashcards');
  });
});
