# MongoDB Atlas: setup and migration guide

**Status: a guide only.** No cluster was created, no network access was changed and no data was migrated.
Every step below is for you to run, after you decide. Atlas's current plans, limits and prices were **not**
checked here: look at the plan page before choosing, and do not assume a free tier is available or enough.

The application needs one thing from a database: a MongoDB (7 or newer) reachable over the internet with a user
that can read and write one database. The database name is the path of the connection string, `trao` locally.

## Part 1: create the database

1. Create an Atlas account and a project. Create a cluster (check the plan, region and price first; choose a
   region close to the Vercel function region, `iad1` by default, for lower latency).
2. **Database Access:** create a database user with a strong generated password and the role **Read and write to
   any database**, or better **a custom role limited to the `trao` database** (`readWrite` on `trao`). Do not use
   the Atlas account login. Keep the password in a password manager.
3. **Network Access:** Atlas only accepts connections from addresses on its allow list. Vercel Functions use
   dynamic IP addresses, so a typical setup allows `0.0.0.0/0` ("anywhere"). **Security implication:** this means
   anyone on the internet can attempt to connect to your database; the only protections are TLS, the database
   user and its password. Reduce the risk: use a long random generated password, a user with `readWrite` on the
   `trao` database only (not an admin role), never reuse the local placeholder password, watch the Atlas access
   log, and remove or narrow the rule after the demo. Narrower options (fixed outbound addresses or private
   connectivity from Vercel) exist on some plans; whether yours has them, and what they cost, was not checked.
   Do not widen access beyond what the deployment needs, and do not add this rule until you are ready to deploy.
4. **Connect:** choose "Drivers" and copy the `mongodb+srv://…` string. Put your database name in it:
   `mongodb+srv://<user>:<password>@<cluster-host>/trao?retryWrites=true&w=majority`.
   URL-encode special characters in the password (`@` is `%40`, `:` is `%3A`, `/` is `%2F`).
5. Put the string only in the Vercel environment variable `MONGODB_URI` (and, if you want to test from your
   machine, in a git-ignored local file or your shell, never in the repository or in a chat).

The application creates its own indexes the first time it runs against the database (`ensureIndexes`), so an
empty database is enough. It needs no manual schema or index setup.

## Part 2: do you need to migrate data?

Probably not. The local database holds test accounts and a few kits. A fresh Atlas database lets you register
again. Migrate only if you want to keep specific kits.

If you do migrate, know what is in each collection:

| Collection        | Contents                                 | Migrate?                                                                  |
| ----------------- | ---------------------------------------- | ------------------------------------------------------------------------- |
| `users`           | Accounts and password hashes             | Yes, if you want to keep the accounts                                     |
| `kits`            | Kits, builder state, research            | Yes (they belong to users by `userId`)                                    |
| `practice_cards`  | Practice progress                        | Optional                                                                  |
| `generation_jobs` | Job history                              | No (local job history is not useful, and active jobs are stale)           |
| `sessions`        | Login sessions (hashed with your secret) | **No.** They are keyed to the local `SESSION_SECRET`; users sign in again |

`kits` reference `users` by ObjectId, so migrate `users` and `kits` together, or the kits become unreachable.

## Part 3: migrate (only if you decide to)

Prerequisites: MongoDB Database Tools (`mongodump`, `mongorestore`) installed. Never run the restore against a
database that already has data you care about. Do **not** use `--drop` unless you intend to replace the target.

0. **Back up the whole local database first** (a read-only operation that changes nothing). Keep it outside the
   repository, because it contains password hashes:

   ```powershell
   $env:LOCAL_URI = "<local connection string from your .env>"
   mongodump --uri="$env:LOCAL_URI" --db=trao --out="$env:USERPROFILE\trao-backup-full"
   ```

   Look inside the folder and confirm it has `users`, `kits`, `sessions`, `generation_jobs` and
   `practice_cards`. Do not delete the local database or the Docker volume afterwards.

1. **Dump the local database** to a folder outside the repository (the dump contains password hashes, so it
   must never be committed). From PowerShell, with the local Docker MongoDB running:

   ```powershell
   $env:LOCAL_URI = "<local connection string from your .env, do not paste it anywhere else>"
   mongodump --uri="$env:LOCAL_URI" --db=trao --out="$env:USERPROFILE\trao-dump" `
     --collection=users
   mongodump --uri="$env:LOCAL_URI" --db=trao --out="$env:USERPROFILE\trao-dump" `
     --collection=kits
   ```

   Repeat with `--collection=practice_cards` if you want it. Look inside the dump folder and confirm that the
   files are what you expect and that `sessions` and `generation_jobs` are not there.

2. **Restore into Atlas** (an empty `trao` database is safest):

   ```powershell
   $env:ATLAS_URI = "<Atlas connection string with the database user>"
   mongorestore --uri="$env:ATLAS_URI" --nsInclude="trao.*" "$env:USERPROFILE\trao-dump"
   ```

3. **Check** with Atlas "Browse Collections" or `mongosh "<atlas uri>"`: `db.users.countDocuments()` and
   `db.kits.countDocuments()` match the local counts, and open one kit to see the `kit` field is intact.
4. Clear the environment variables when done (`Remove-Item Env:LOCAL_URI, Env:ATLAS_URI`) and delete the dump
   folder, which holds password hashes.

Passwords are stored as hashes, so migrated accounts keep working. Sessions do not carry over, so everyone signs
in again.

## Part 4: switch the application over

1. In Vercel, set `MONGODB_URI` to the Atlas string for the API service, and redeploy.
2. Open `https://<domain>/api/ready`: it answers `ready` only if the database responds.
3. Register or sign in and create a kit. Look at the `kits` collection in Atlas to confirm the document is there.

## Rolling back and cleaning up

- Switching back to the local database is just changing `MONGODB_URI` again; nothing was changed locally.
- Atlas billing, pausing and deleting a cluster are done in the Atlas console. Deleting a cluster deletes its
  data permanently.
