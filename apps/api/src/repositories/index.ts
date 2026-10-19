import type { Db } from 'mongodb';
import { collections } from '../db.js';
import { jobRepository } from './jobs.js';
import { kitRepository } from './kits.js';
import { sessionRepository } from './sessions.js';
import { userRepository } from './users.js';

export function createRepositories(db: Db) {
  const c = collections(db);
  return {
    users: userRepository(c),
    sessions: sessionRepository(c),
    kits: kitRepository(c),
    jobs: jobRepository(c),
  };
}

export type Repositories = ReturnType<typeof createRepositories>;
