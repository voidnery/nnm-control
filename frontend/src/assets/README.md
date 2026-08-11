# Vendored data

## countries.json

Country outlines, from Natural Earth 1:110m Admin 0 (public domain), reduced to
what this panel needs: ISO alpha-2 code, name, and outer rings at two decimal
places. 175 countries, 10,542 points, 155 kB — against 838 kB for the source.

It does double duty. It is the drawing on the globe *and* the answer to "which
country did the operator just click", so a click is resolved with no external
service and no network request.

Known limitation, asserted by a test rather than left to be discovered:
**110m omits micro-states entirely** — Singapore, Malta, Monaco, Liechtenstein
and Andorra are smaller than the simplification tolerance. A click on Singapore
names Malaysia. The alternative is 10m data at roughly ten times the size, for
a globe whose job is to show fourteen servers.

Holes are dropped: a lake does not change which country a click is in.

Regenerate with:

    curl -sSL -o ne110.geojson \
      https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson

then keep ISO_A2_EH (falling back to ISO_A2), NAME, and each polygon's outer
ring rounded to two decimals.
