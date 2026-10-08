import { Router } from 'express';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import HttpException from '../exceptions/HttpException';

/**
 * `GET /skill.md` — the integration guide, as raw Markdown.
 *
 * The same guide the `/docs` page renders, in the form an agent or a developer
 * can pipe into a file: no HTML, no navigation, no styling. It is served rather
 * than linked so that `curl http://<host>/skill.md > skill.md` is the whole
 * integration step, and so the file an agent reads is the one this deployment
 * actually runs — a copy hosted anywhere else would describe some other build.
 *
 * The content is read from `skill.md` at the backend root rather than from
 * `src/`, because `tsc` compiles `src/` to `dist/` and copies no other file
 * type: a Markdown file under `src/` would exist in development and be missing
 * from every built deployment. The root is the one place both `bun --watch
 * src/server.ts` and `bun dist/server.js` agree on.
 *
 * Read once and held in memory. It is a few tens of kilobytes, it never
 * changes while the process is running, and re-reading it per request would put
 * a disk read in front of every agent that fetches it.
 */

/** Resolved from this module, not from the working directory, so it is the same
 * file whether the process was started from `src/` or from `dist/`. */
const SKILL_PATH = resolve(import.meta.dir, '..', '..', 'skill.md');

let cached: string | null = null;

/**
 * The guide's text, or an error the caller can act on.
 *
 * A missing file is a deployment fault — the build shipped without its guide —
 * and the message says so rather than reporting a generic failure. The absolute
 * path is deliberately not included: it would leak the server's layout to an
 * unauthenticated caller, and the operator has the logs.
 */
function skillMarkdown(): string {
  if (cached !== null) return cached;

  try {
    cached = readFileSync(SKILL_PATH, 'utf8');

    return cached;
  } catch (error) {
    throw new HttpException(500, 'The integration guide is not available on this deployment.');
  }
}

class SkillRoute implements IAppRoute {
  public path = '/';
  public router = Router();

  constructor() {
    this.initializeRoutes();
  }

  private initializeRoutes() {
    this.router.get('/skill.md', (req, res, next) => {
      try {
        const markdown = skillMarkdown();

        // `charset=utf-8` matters: the guide contains `→`, `≤` and `—`, and a
        // client that guessed latin-1 from the media type alone would mangle
        // them in exactly the copy-paste path this endpoint exists for.
        res.type('text/markdown; charset=utf-8').send(markdown);
      } catch (error) {
        next(error);
      }
    });
  }
}

export default SkillRoute;
