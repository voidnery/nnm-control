Test databases vendored from https://github.com/maxmind/MaxMind-DB (test-data/),
MIT licensed. They contain synthetic records only and exist so the MMDB reading
path is exercised offline, without shipping or downloading a real geolocation
database in CI.

They are NOT the database the panel uses at runtime. That is DB-IP Lite
(CC BY 4.0, https://db-ip.com), fetched into the data volume on demand.
