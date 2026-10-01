# Visitor check-in workshop

The maintained package is `artifacts/sparkproj/visitor-checkin.sparkproj`. Its
independently authored source is `examples/visitor-checkin.json`; build it with
the normal workshop builder. Import creates a separate, unpublished project.
This workshop requires preview.11 or a later compatible build, including
**Computer camera** and the Image component's transient `imageUrl` binding.
These additions are not in preview.10 installers.

## Try the application

1. Import the package from the Projects page. Open Designer and review the
   welcome form, static host choices and the `visitor-controller` message
   handlers. Save any changes and publish as a gateway administrator.
2. Open the operator link with Operate permission. Use a browser on HTTPS or
   localhost with a webcam and internet access. Designer Preview also works
   after explicitly enabling live actions; read-only Preview does not run the
   browser handlers.
3. Enter a name and email, then select a host. For workshop testing use
   synthetic values such as **Taylor Visitor**, **taylor.visitor@example.com**
   and **Alex Morgan**.
4. Click **Start camera**, allow browser camera access, then **Capture photo**.
   The photo is captured as a square. **Retake** lets you replace it. No camera
   starts merely because the page opened.
5. Click **Create badge**. The application converts the photo to a monochrome
   ZPL graphic, posts the completed label to Labelary, then shows its returned
   PNG. The badge contains name, email, host and photo.
6. Click **Dismiss**. The blank welcome form returns; visitor values, the photo
   and badge are cleared from this runtime. Start the camera again for the next
   visitor.

If camera access is denied, allow it through the browser's site permissions and
retry Start camera. Access through an unencrypted LAN IP cannot use the browser
camera: configure HTTPS or test on localhost. Rendering failures leave the form
and photo available for an explicit retry. There is no automatic retry. Empty
fields, an invalid email, an unknown host or a missing photo never call Labelary.

## Where the data goes

Create badge sends the name, email, selected host and monochrome photo to the
external [Labelary service](https://labelary.com/service.html). The free service
does not promise zero data retention. Use synthetic details while learning and
review the service arrangement before using real visitor data. Dismiss clears
this browser's local values; it cannot erase data already received by Labelary.

The workshop does not save a visitor register, write tags, use a database,
notify the host, or print to a printer. Each open operator session keeps its own
form and badge. A reload resets it. Publishing/exporting the project includes
the authored empty defaults and scripts, not a visitor's runtime values or
photos. The static host options and the handler's host map should be changed
together when adapting the project.

## How it works

`visitor-controller` is the ID of a tiny, blank Label at the top-left of the
Welcome screen. It keeps the browser request and cleanup handlers mounted while
the form and badge change visibility. In Designer, select **Welcome**, then
**visitor-controller** in the left **Layers** list. Its ID is shown under
**General → Component ID** in the right property sheet. Open **Edit actions &
events → Messages** to inspect its `visitor-check-in` and `visitor-dismiss`
handlers. Their handler IDs are `check-in` and `dismiss`; those are distinct from
the component ID and the message types used by the two buttons.

When a button uses **Send message**, the editor suggests authored message types
and lists receiver definitions with their screen/template, component ID, language
and scope. The list describes where handlers are authored. Delivery still depends
on a matching type and scope and on the component being mounted in that runtime.

The inputs and Computer camera bind to typed **screen state**. Create badge sends
`visitor-check-in` to a screen-scoped JavaScript message handler. It synchronously
marks the form busy and starts a bounded asynchronous request, so repeated clicks
do not create duplicate renders. This uses browser code because camera capture,
canvas image processing and transient image URLs belong to the visitor's browser.

The captured PNG is cropped to 192×192, converted to a one-bit dithered graphic
and encoded as ZPL `^GFA`. All visitor text is UTF-8 hex-escaped using `^FH`, so
characters such as `^`, `~` and `_` remain text instead of introducing commands.
The authored 4×3-inch label uses 8 dots/mm. A POST carries raw ZPL with
`Content-Type: application/x-www-form-urlencoded` and `Accept: image/png`, as
specified by the [Labelary API](https://labelary.com/service.html).

The handler checks status, MIME type, size and PNG signature. It places a short,
same-origin blob URL in `badgeUrl`; the Image's `imageUrl` binding displays the
returned image. Large base64 images are not put in typed state. The welcome form
and badge occupy the same screen, with visibility bindings selecting the current
step. Dismiss sends `visitor-dismiss`, revokes the badge URL and resets screen
state. Camera capture owns and revokes its photo URL, stops video tracks, and
clears on reset or departure. The controller also revokes its badge on unmount.

The rendering job has a 20-second deadline and is cancelled when its component
is retired. Late responses cannot restore a dismissed or departed screen.
HTTP 429 shows a wait-and-retry message; the free API currently limits requests
to three per second and 5,000 per day. Consult the linked service documentation
for current limits.

## Verification

Run the focused camera, transient-image and visitor-script checks, then the
ordinary production web build and workshop checks. The workshop package verifier
checks import, explicit publication and re-export against an isolated gateway;
it does not exercise camera permissions or execute external requests. Browser
walkthrough acceptance uses synthetic details and a synthetic camera fixture so
that no real person's image is captured or transmitted during testing.
