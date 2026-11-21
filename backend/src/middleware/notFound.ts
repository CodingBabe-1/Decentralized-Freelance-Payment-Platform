import { RequestHandler } from "express";

/**
 * Catch-all for requests that matched no router.
 *
 * Express ships a built-in "final handler" that answers an unmatched path with
 * `text/html`:
 *
 *     <!DOCTYPE html><html>...Cannot GET /api/nope...</html>
 *
 * Every route on this API answers JSON, so a client that does `res.json()` on
 * the error path throws a parse error on the one response it cannot read — the
 * 404 is the *only* body in the whole API with a different content type, and it
 * is the one a typo'd path is most likely to hit.
 *
 * It is mounted after every router and before `errorHandler`, so a matched
 * route never reaches it, and a thrown error still goes to `errorHandler`.
 * The body mirrors `errorHandler`'s `{ error: string }` shape so a client has
 * one error contract to parse regardless of status code.
 */
export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({
    error: {
      code: "NOT_FOUND",
      message: "Not found",
    },
  });
};
