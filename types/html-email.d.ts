/**
 * `bgcolor` on table cells, for the email template.
 *
 * React renders the attribute — it is valid HTML — but React 19's types dropped it
 * from `<td>` and `<th>`, keeping it only on `<table>`. In a browser that is fine,
 * because CSS `background-color` does the job. In email it is not: Outlook's Word
 * renderer discards `background-color` on many elements, and a cell that loses its
 * background in a dark template leaves white behind pale text.
 *
 * So the template sets both, and this restores the type. Scoped to the attributes
 * email actually needs rather than reopening the whole surface.
 */
import "react";

declare module "react" {
  interface TdHTMLAttributes<T> extends HTMLAttributes<T> {
    bgcolor?: string;
  }
  interface ThHTMLAttributes<T> extends HTMLAttributes<T> {
    bgcolor?: string;
  }
}
