# WMSPanel API — the Application section, as published

**Source.** Copied by hand from `https://wmspanel.com/api_info?g=application`
on 2026-08-16 by the operator. That URL is refused to automated readers and
plain `/api_info` serves only its stats half, so this file — not a search, not
a probe, not a recollection — is the reading of this section.

It is kept verbatim. When more sections are copied they are appended here or
placed beside this file under the same rule: **the published text is the
source, and paraphrase of it belongs in `wmspanel-api.md`, not here.**

---

# **Get list**  **Retrieve a list of live applications for particular Nimble server. You can view this list by navigating to "Nimble Streamer / Live streams settings" menu item, then choosing appropriate Nimble server and "Applications" tab.** **Request URL:** **GET https://api.wmspanel.com/v1/server/\[server\_id\]/live/app** **Request parameters:**

* server\_id \- is ID of appropriate nimble server, you can get it from the "Get servers list" API call  
* client\_id \- is \[client\_id\] you've copied previously from UI  
* api\_key \- is \[api\_key\] from UI

**CURL request example:**  
curl 'https://api.wmspanel.com/v1/server/552b56aa0640fd4e95000002/live/app?client\_id=\[client\_id\]\&api\_key=\[api\_key\]'  
**Response example:**

```
{
    "status": "Ok",
    "applications": [
        {
            "id": "552c97320640fdd1bf000002",
            "application": "nimble-live",
            "chunk_duration": 6,
            "chunk_count": 4,
            "protocols": [
                "HLS",
                "DASH"
            ],
            "push_login": "",
            "push_password": "",
            "empty_credentials": false,
            "dash_template": "NUMBER",
            "dvb_subs_to_webvtt": "disabled",
            "transcribe_audio_to_webvtt": false,
            "generate_cea708_subtitles": false,
            "generate_webvtt_subtitles_from_cea708": false,
            "ic_enabled": true,
            "ic_min_delay_ms": 1000,
            "ic_max_delay_ms": 3000,
            "ic_max_queue_items": 250,
            "alhls_enabled": true,
            "hls_part_duration": 500,
            "mp4_thumbnails": true,
            "mp4_thumbnails_interval": 6,
            "jpg_thumbnails": true,
            "jpg_thumbnails_interval": 6,
            "jpg_thumbnail_width": 4096,
            "jpg_thumbnail_height": 2048,
            "tags": ["Live sports"]
        },
        {
            "id": "552c976c0640fdd1bf000003",
            "application": "stv",
            "chunk_duration": 6,
            "chunk_count": 4,
            "protocols": [
                "HLS",
                "MPEG2TS",
                "ICECAST",
                "DASH",
                "SLDP"
            ],
            "push_login": "",
            "push_password": "",
            "empty_credentials": true,
            "dash_template": "TIME",
            "dvb_subs_to_webvtt": "replace",
            "ic_enabled": false,
            "gen_icecast_metadata": true,
            "alhls_enabled": false,
            "tags": ["Live news"]
        }
    ]
}
```

**Response fields:**

* **id** \- unique application ID for further usage.  
* **application** \- streaming application name  
* **chunk\_duration** \- duration of chunks for each outgoing stream in application.  
* **chunk\_count** \- number of chunks cached by server for each outgoing stream in application.  
* **protocols** \- list of protocols that are used for providing output streams in application. HLS, HLS\_MPEGTS, HLS\_FMP4, RTMP, RTSP, MPEG2TS, ICECAST, DASH, SLDP and WebRTC (WHEP) options are available. All protocols can be used simultaneously, except HLS and HLS\_MPEGTS can't be used together.  
* **push\_login** \- login for all incoming published RTMP/RTSP streams in application.  
* **push\_password** \- password for all incoming published RTMP/RTSP streams in application.  
* **empty\_credentials** \- boolean flag to prevent using login and password from Global settings, when application login and password are empty.  
* **dash\_template** \- DASH segment template defined as string ("TIME" for time-based, "NUMBER" for number-based).  
* **dvb\_subs\_to\_webvtt** \- DVB subtitles to WebVTT conversion mode defined as string ("disabled", "add" or "replace"). Ignored by Nimble if "transcribe\_audio\_to\_webvtt" is true.  
* **transcribe\_audio\_to\_webvtt** \- boolean value to enable generating WebVTT from audio.  
* **generate\_cea708\_subtitles** \- boolean value to enable generating CEA-708 subtitles. It is impossible to enable generate\_cea708\_subtitles and generate\_webvtt\_subtitles\_from\_cea708 at same time. At least one of them should be false.  
* **generate\_webvtt\_subtitles\_from\_cea708** \- boolean value to enable generating WebVTT subtitles from CEA-708. It is impossible to enable generate\_cea708\_subtitles and generate\_webvtt\_subtitles\_from\_cea708 at same time. At least one of them should be false.  
* **cea708\_mode** \- string value to set CEA-708 subtitles mode. Ignored by Nimble if "generate\_cea708\_subtitles" is false. The value can be one of "rollup2", "rollup3", "rollup4" or "popon".  
* **cea708\_timeout** \- string value to set CEA-708 subtitles timeout in milliseconds. Ignored by Nimble if "generate\_cea708\_subtitles" is false or "cea708\_mode" is "popon". The value must be in the range from 500 to 30000\.  
* **cea708\_style** \- string value to set CEA-708 subtitles style. Ignored by Nimble if "generate\_cea708\_subtitles" is false or "cea708\_mode" is "popon". The value can be one of "red", "green", "blue", "cyan", "yellow", "magenta", "italics" or "white".  
* **cea708\_row** \- string value to set CEA-708 subtitles row. Ignored by Nimble if "generate\_cea708\_subtitles" is false or "cea708\_mode" is "popon". The value must be in the range from 5 to 15\.  
* **cea708\_underline** \- boolean value to set CEA-708 subtitles underline. Ignored by Nimble if "generate\_cea708\_subtitles" is false or "cea708\_mode" is "popon".  
* **ic\_enabled** \- boolean value to enable interleaving compensation.  
* **ic\_min\_delay\_ms** \- minimum delay in milliseconds for interleaving compensation. Applicable if ic\_enabled is true.  
* **ic\_max\_delay\_ms** \- maximum delay in milliseconds for interleaving compensation. Applicable if ic\_enabled is true.  
* **ic\_max\_queue\_items** \- maximum number of queue items for interleaving compensation. Applicable if ic\_enabled is true.  
* **gen\_icecast\_metadata** \- boolean value to enable Icecast metadata generating. Applicable for Icecast protocol only.  
* **alhls\_enabled** \- boolean value to enable Apple’s Low-Latency HLS. Applicable for HLS, HLS\_MPEGTS and HLS\_FMP4 protocols only.  
* **hls\_part\_duration** \- HLS part duration in milliseconds for ALHLS. Should be greater or equal to 250 and less or equal to half of chunk\_duration\*1000 value. Applicable for HLS, HLS\_MPEGTS and HLS\_FMP4 protocols only, if alhls\_enabled is true.  
* **mp4\_thumbnails** \- boolean value to enable MP4 thumbnails generating.  
* **mp4\_thumbnails\_interval** \- MP4 thumbnails interval in seconds. Should be greater or equal to 0 and less or equal to 60\.  
* **jpg\_thumbnails** \- boolean value to enable JPG thumbnails generating.  
* **jpg\_thumbnails\_interval** \- Alias for mp4\_thumbnails\_interval. Currently both MP4 and JPG thumbnails use same interval.  
* **jpg\_thumbnail\_width** \- JPEG thumbnails width.  
* **jpg\_thumbnail\_height** \- JPEG thumbnails height.  
* **tags** \- custom tags for easy filtering on the settings web page.

# **Get**

Pick up an application  
**Request URL:**  
GET https://api.wmspanel.com/v1/server/\[server\_id\]/live/app/\[app\_id\]  
**Request parameters:**

* app\_id \- is ID of the RTMP application obtained via "Get RTMP applcations list" method.  
* server\_id \- is ID of appropriate nimble server, you can get it from the "Get servers list" API call  
* client\_id \- is \[client\_id\] you've copied previously from UI  
* api\_key \- is \[api\_key\] from UI

**CURL request example:**  
curl 'https://api.wmspanel.com/v1/server/538bcbd3f5aef0bed900000d/live/app/552c97320640fdd1bf000002?client\_id=\[client\_id\]\&api\_key=\[api\_key\]'  
**Response example:**

```
{
    "status": "Ok",
    "application": {
        "id": "552c97320640fdd1bf000002",
        "application": "nimble-live",
        "chunk_duration": 6,
        "chunk_count": 4,
        "protocols": [
            "HLS",
            "DASH"
        ],
        "push_login": "",
        "push_password": "",
        "empty_credentials": false,
        "dash_template": "NUMBER",
        "dvb_subs_to_webvtt": "disabled",
        "transcribe_audio_to_webvtt": false,
        "generate_cea708_subtitles": false,
        "generate_webvtt_subtitles_from_cea708": false,
        "ic_enabled": true,
        "ic_min_delay_ms": 1000,
        "ic_max_delay_ms": 3000,
        "ic_max_queue_items": 250,
        "alhls_enabled": true,
        "hls_part_duration": 500,
        "mp4_thumbnails": true,
        "mp4_thumbnails_interval": 6,
        "jpg_thumbnails": true,
        "jpg_thumbnails_interval": 6,
        "jpg_thumbnail_width": 4096,
        "jpg_thumbnail_height": 2048,
        "tags": ["Live sports"]
    }
}
```

**Response fields:**

* **id** \- unique application ID for further usage.  
* **application** \- streaming application name  
* **chunk\_duration** \- duration of chunks for each outgoing stream in application.  
* **chunk\_count** \- number of chunks cached by server for each outgoing stream in application.  
* **protocols** \- list of protocols that are used for providing output streams in application. HLS, HLS\_MPEGTS, HLS\_FMP4, RTMP, RTSP, MPEG2TS, ICECAST, DASH, SLDP and WebRTC (WHEP) options are available. All protocols can be used simultaneously, except HLS and HLS\_MPEGTS can't be used together.  
* **push\_login** \- login for all incoming published RTMP/RTSP streams in application.  
* **push\_password** \- password for all incoming published RTMP/RTSP streams in application.  
* **empty\_credentials** \- boolean flag to prevent using login and password from Global settings, when application login and password are empty.  
* **dash\_template** \- DASH segment template defined as string ("TIME" for time-based, "NUMBER" for number-based).  
* **dvb\_subs\_to\_webvtt** \- DVB subtitles to WebVTT conversion mode defined as string ("disabled", "add" or "replace"). Ignored by Nimble if "transcribe\_audio\_to\_webvtt" is true.  
* **transcribe\_audio\_to\_webvtt** \- boolean value to enable generating WebVTT from audio.  
* **generate\_cea708\_subtitles** \- boolean value to enable generating CEA-708 subtitles. It is impossible to enable generate\_cea708\_subtitles and generate\_webvtt\_subtitles\_from\_cea708 at same time. At least one of them should be false.  
* **generate\_webvtt\_subtitles\_from\_cea708** \- boolean value to enable generating WebVTT subtitles from CEA-708. It is impossible to enable generate\_cea708\_subtitles and generate\_webvtt\_subtitles\_from\_cea708 at same time. At least one of them should be false.  
* **cea708\_mode** \- string value to set CEA-708 subtitles mode. Ignored by Nimble if "generate\_cea708\_subtitles" is false. The value can be one of "rollup2", "rollup3", "rollup4" or "popon".  
* **cea708\_timeout** \- string value to set CEA-708 subtitles timeout in milliseconds. Ignored by Nimble if "generate\_cea708\_subtitles" is false or "cea708\_mode" is "popon". The value must be in the range from 500 to 30000\.  
* **cea708\_style** \- string value to set CEA-708 subtitles style. Ignored by Nimble if "generate\_cea708\_subtitles" is false or "cea708\_mode" is "popon". The value can be one of "red", "green", "blue", "cyan", "yellow", "magenta", "italics" or "white".  
* **cea708\_row** \- string value to set CEA-708 subtitles row. Ignored by Nimble if "generate\_cea708\_subtitles" is false or "cea708\_mode" is "popon". The value must be in the range from 5 to 15\.  
* **cea708\_underline** \- boolean value to set CEA-708 subtitles underline. Ignored by Nimble if "generate\_cea708\_subtitles" is false or "cea708\_mode" is "popon".  
* **ic\_enabled** \- boolean value to enable interleaving compensation.  
* **ic\_min\_delay\_ms** \- minimum delay in milliseconds for interleaving compensation. Applicable if ic\_enabled is true.  
* **ic\_max\_delay\_ms** \- maximum delay in milliseconds for interleaving compensation. Applicable if ic\_enabled is true.  
* **ic\_max\_queue\_items** \- maximum number of queue items for interleaving compensation. Applicable if ic\_enabled is true.  
* **gen\_icecast\_metadata** \- boolean value to enable Icecast metadata generating. Applicable for Icecast protocol only.  
* **alhls\_enabled** \- boolean value to enable Apple’s Low-Latency HLS. Applicable for HLS, HLS\_MPEGTS and HLS\_FMP4 protocols only.  
* **hls\_part\_duration** \- HLS part duration in milliseconds for ALHLS. Should be greater or equal to 250 and less or equal to half of chunk\_duration\*1000 value. Applicable for HLS, HLS\_MPEGTS and HLS\_FMP4 protocols only, if alhls\_enabled is true.  
* **mp4\_thumbnails** \- boolean value to enable MP4 thumbnails generating.  
* **mp4\_thumbnails\_interval** \- MP4 thumbnails interval in seconds. Should be greater or equal to 0 and less or equal to 60\.  
* **jpg\_thumbnails** \- boolean value to enable JPG thumbnails generating.  
* **jpg\_thumbnails\_interval** \- Alias for mp4\_thumbnails\_interval. Currently both MP4 and JPG thumbnails use same interval.  
* **jpg\_thumbnail\_width** \- JPEG thumbnails width.  
* **jpg\_thumbnail\_height** \- JPEG thumbnails height.  
* **tags** \- custom tags for easy filtering on the settings web page.

# **Create**

Create a new application.  
**Request URL:**  
POST https://api.wmspanel.com/v1/server/\[server\_id\]/live/app  
**Request parameters:**

* server\_id \- is ID of appropriate nimble server, you can get it from the "Get servers list" API call  
* client\_id \- is \[client\_id\] you've copied previously from UI  
* api\_key \- is \[api\_key\] from UI

**CURL request example:**  
curl \-X POST \-H 'Content-Type: application/json' \-d '{"application": "welcome"}' "https://api.wmspanel.com/v1/server/538bcbd3f5aef0bed900000d/live/app?client\_id=\[client\_id\]\&api\_key=\[api\_key\]"

The 'Content-Type: application/json' header is important. Request data is sent within request body.

**Request data fields:**

* **application** \- streaming application name  
* **chunk\_duration** (optional) \- duration of chunks for each outgoing stream in application. If not specified, then default value is 6 seconds.  
* **chunk\_count** (optional) \- number of chunks cached by server for each outgoing stream in application. If not specified, then default value is 4\.  
* **protocols** (optional) \- list of protocols that are used for providing output streams in application. HLS, HLS\_MPEGTS, HLS\_FMP4, RTMP, RTSP, MPEG2TS, ICECAST, DASH, SLDP and WebRTC (WHEP) options are available. All protocols can be used simultaneously, except HLS and HLS\_MPEGTS can't be used together. If not specified, then HLS is used by default.  
* **push\_login** (optional) \- login for all incoming published RTMP/RTSP streams in application.  
* **push\_password** (optional) \- password for all incoming published RTMP/RTSP streams in application.  
* **empty\_credentials** (optional) \- boolean flag to prevent using login and password from Global settings, when application login and password are empty.  
* **dash\_template** (optional) \- DASH segment template defined as string ("TIME" for time-based, "NUMBER" for number-based).  
* **dvb\_subs\_to\_webvtt** (optional) \- DVB subtitles to WebVTT conversion mode defined as string ("disabled", "add" or "replace"). Ignored by Nimble if "transcribe\_audio\_to\_webvtt" is true.  
* **transcribe\_audio\_to\_webvtt** (optional) \- boolean value to enable generating WebVTT from audio.  
* **generate\_cea708\_subtitles** (optional) \- boolean value to enable generating CEA-708 subtitles. It is impossible to enable generate\_cea708\_subtitles and generate\_webvtt\_subtitles\_from\_cea708 at same time. At least one of them should be false.  
* **generate\_webvtt\_subtitles\_from\_cea708** (optional) \- boolean value to enable generating WebVTT subtitles from CEA-708. It is impossible to enable generate\_cea708\_subtitles and generate\_webvtt\_subtitles\_from\_cea708 at same time. At least one of them should be false.  
* **cea708\_mode** (optional) \- string value to set CEA-708 subtitles mode. Ignored by Nimble if "generate\_cea708\_subtitles" is false. The value can be one of "rollup2", "rollup3", "rollup4" or "popon".  
* **cea708\_timeout** (optional) \- string value to set CEA-708 subtitles timeout in milliseconds. Ignored by Nimble if "generate\_cea708\_subtitles" is false or "cea708\_mode" is "popon". The value must be in the range from 500 to 30000\.  
* **cea708\_style** (optional) \- string value to set CEA-708 subtitles style. Ignored by Nimble if "generate\_cea708\_subtitles" is false or "cea708\_mode" is "popon". The value can be one of "red", "green", "blue", "cyan", "yellow", "magenta", "italics" or "white".  
* **cea708\_row** (optional) \- string value to set CEA-708 subtitles row. Ignored by Nimble if "generate\_cea708\_subtitles" is false or "cea708\_mode" is "popon". The value must be in the range from 5 to 15\.  
* **cea708\_underline** (optional) \- boolean value to set CEA-708 subtitles underline. Ignored by Nimble if "generate\_cea708\_subtitles" is false or "cea708\_mode" is "popon".  
* **ic\_enabled** (optional) \- boolean value to enable interleaving compensation.  
* **ic\_min\_delay\_ms** (optional) \- minimum delay in milliseconds for interleaving compensation. Applicable if ic\_enabled is true.  
* **ic\_max\_delay\_ms** (optional) \- maximum delay in milliseconds for interleaving compensation. Applicable if ic\_enabled is true.  
* **ic\_max\_queue\_items** (optional) \- maximum number of queue items for interleaving compensation. Applicable if ic\_enabled is true.  
* **gen\_icecast\_metadata** (optional) \- boolean value to enable Icecast metadata generating. Applicable for Icecast protocol only.  
* **alhls\_enabled** (optional) \- boolean value to enable Apple’s Low-Latency HLS. Applicable for HLS, HLS\_MPEGTS and HLS\_FMP4 protocols only.  
* **hls\_part\_duration** (optional) \- HLS part duration in milliseconds for ALHLS. Should be greater or equal to 250 and less or equal to half of chunk\_duration\*1000 value. Applicable for HLS, HLS\_MPEGTS and HLS\_FMP4 protocols only, if alhls\_enabled is true.  
* **mp4\_thumbnails** (optional) \- boolean value to enable MP4 thumbnails generating.  
* **mp4\_thumbnails\_interval** (optional) \- MP4 thumbnails interval in seconds. Should be greater or equal to 0 and less or equal to 60\.  
* **jpg\_thumbnails** (optional) \- boolean value to enable JPG thumbnails generating.  
* **jpg\_thumbnails\_interval** (optional) \- Alias for mp4\_thumbnails\_interval. Currently both MP4 and JPG thumbnails use same interval.  
* **jpg\_thumbnail\_width** (optional) \- JPEG thumbnails width.  
* **jpg\_thumbnail\_height** (optional) \- JPEG thumbnails height.  
* **tags** (optional) \- custom tags for easy filtering on the settings web page.

**Response example:**

```
{
    "status": "Ok",
    "application": {
        "id": "552c97d00640fdd1bf000004",
        "application": "welcome",
        "chunk_duration": 6,
        "chunk_count": 4,
        "protocols": [
            "HLS"
        ],
        "push_login": "",
        "push_password": "",
        "empty_credentials": false,
        "dash_template": "TIME",
        "dvb_subs_to_webvtt": "disabled",
        "transcribe_audio_to_webvtt": false,
        "generate_cea708_subtitles": false,
        "generate_webvtt_subtitles_from_cea708": false,
        "ic_enabled": false,
        "alhls_enabled": false,
        "mp4_thumbnails": true,
        "mp4_thumbnails_interval": 6,
        "jpg_thumbnails": true,
        "jpg_thumbnails_interval": 6,
        "jpg_thumbnail_width": 4096,
        "jpg_thumbnail_height": 2048
    }
}
```

**Response fields:** The same as in "Get an existing application". 

# **Update**

Update an existing application.  
**Request URL:**  
PUT https://api.wmspanel.com/v1/server/\[server\_id\]/live/app/\[app\_id\]  
**Request parameters:**

* app\_id \- is ID of the application obtained via "Get applications list" method.  
* server\_id \- is ID of appropriate nimble server, you can get it from the "Get servers list" API call  
* client\_id \- is \[client\_id\] you've copied previously from UI  
* api\_key \- is \[api\_key\] from UI

**CURL request example:**  
curl \-X PUT \-H 'Content-Type: application/json' \-d '{"chunk\_duration": 10, "chunk\_count": 10, "protocols": \["HLS", "RTMP", "ICECAST", "DASH"\], "push\_login": "user", "push\_password": "pass", "tags": \["Live sports"\]}' "https://api.wmspanel.com/v1/server/538bcbd3f5aef0bed900000d/live/app/552c97320640fdd1bf000002?client\_id=\[client\_id\]\&api\_key=\[api\_key\]"

The 'Content-Type: application/json' header is important. Request data is sent within request body.

**Request data fields:**

* **application** \- streaming application name  
* **chunk\_duration** \- duration of chunks for each outgoing stream in application.  
* **chunk\_count** \- number of chunks cached by server for each outgoing stream in application.  
* **protocols** \- list of protocols that are used for providing output streams in application. HLS, HLS\_MPEGTS, HLS\_FMP4, RTMP, RTSP, MPEG2TS, ICECAST, DASH, SLDP and WebRTC (WHEP) options are available. All protocols can be used simultaneously, except HLS and HLS\_MPEGTS can't be used together.  
* **push\_login** \- login for all incoming published RTMP/RTSP streams in application.  
* **push\_password** \- password for all incoming published RTMP/RTSP streams in application.  
* **empty\_credentials** \- boolean flag to prevent using login and password from Global settings, when application login and password are empty.  
* **dash\_template** \- DASH segment template defined as string ("TIME" for time-based, "NUMBER" for number-based).  
* **dvb\_subs\_to\_webvtt** \- DVB subtitles to WebVTT conversion mode defined as string ("disabled", "add" or "replace"). Ignored by Nimble if "transcribe\_audio\_to\_webvtt" is true.  
* **transcribe\_audio\_to\_webvtt** \- boolean value to enable generating WebVTT from audio.  
* **generate\_cea708\_subtitles** \- boolean value to enable generating CEA-708 subtitles. It is impossible to enable generate\_cea708\_subtitles and generate\_webvtt\_subtitles\_from\_cea708 at same time. At least one of them should be false.  
* **generate\_webvtt\_subtitles\_from\_cea708** \- boolean value to enable generating WebVTT subtitles from CEA-708. It is impossible to enable generate\_cea708\_subtitles and generate\_webvtt\_subtitles\_from\_cea708 at same time. At least one of them should be false.  
* **cea708\_mode** \- string value to set CEA-708 subtitles mode. Ignored by Nimble if "generate\_cea708\_subtitles" is false. The value can be one of "rollup2", "rollup3", "rollup4" or "popon".  
* **cea708\_timeout** \- string value to set CEA-708 subtitles timeout in milliseconds. Ignored by Nimble if "generate\_cea708\_subtitles" is false or "cea708\_mode" is "popon". The value must be in the range from 500 to 30000\.  
* **cea708\_style** \- string value to set CEA-708 subtitles style. Ignored by Nimble if "generate\_cea708\_subtitles" is false or "cea708\_mode" is "popon". The value can be one of "red", "green", "blue", "cyan", "yellow", "magenta", "italics" or "white".  
* **cea708\_row** \- string value to set CEA-708 subtitles row. Ignored by Nimble if "generate\_cea708\_subtitles" is false or "cea708\_mode" is "popon". The value must be in the range from 5 to 15\.  
* **cea708\_underline** \- boolean value to set CEA-708 subtitles underline. Ignored by Nimble if "generate\_cea708\_subtitles" is false or "cea708\_mode" is "popon".  
* **ic\_enabled** \- boolean value to enable interleaving compensation.  
* **ic\_min\_delay\_ms** \- minimum delay in milliseconds for interleaving compensation. Applicable if ic\_enabled is true.  
* **ic\_max\_delay\_ms** \- maximum delay in milliseconds for interleaving compensation. Applicable if ic\_enabled is true.  
* **ic\_max\_queue\_items** \- maximum number of queue items for interleaving compensation. Applicable if ic\_enabled is true.  
* **gen\_icecast\_metadata** \- boolean value to enable Icecast metadata generating. Applicable for Icecast protocol only.  
* **alhls\_enabled** \- boolean value to enable Apple’s Low-Latency HLS. Applicable for HLS, HLS\_MPEGTS and HLS\_FMP4 protocols only.  
* **hls\_part\_duration** \- HLS part duration in milliseconds for ALHLS. Should be greater or equal to 250 and less or equal to half of chunk\_duration\*1000 value. Applicable for HLS, HLS\_MPEGTS and HLS\_FMP4 protocols only, if alhls\_enabled is true.  
* **mp4\_thumbnails** \- boolean value to enable MP4 thumbnails generating.  
* **mp4\_thumbnails\_interval** \- MP4 thumbnails interval in seconds. Should be greater or equal to 0 and less or equal to 60\.  
* **jpg\_thumbnails** \- boolean value to enable JPG thumbnails generating.  
* **jpg\_thumbnails\_interval** \- Alias for mp4\_thumbnails\_interval. Currently both MP4 and JPG thumbnails use same interval.  
* **jpg\_thumbnail\_width** \- JPEG thumbnails width.  
* **jpg\_thumbnail\_height** \- JPEG thumbnails height.  
* **tags** \- custom tags for easy filtering on the settings web page.

All fields are optional.

**Response example:**

```
{
    "status": "Ok",
    "application": {
        "id": "552c97320640fdd1bf000002",
        "application": "nimble-live",
        "chunk_duration": 10,
        "chunk_count": 10,
        "protocols": [
            "HLS",
            "RTMP",
            "ICECAST",
            "DASH"
        ],
        "push_login": "user",
        "push_password": "pass",
        "empty_credentials": false,
        "dash_template": "NUMBER",
        "dvb_subs_to_webvtt": "disabled",
        "transcribe_audio_to_webvtt": false,
        "generate_cea708_subtitles": false,
        "generate_webvtt_subtitles_from_cea708": false,
        "ic_enabled": true,
        "ic_min_delay_ms": 1000,
        "ic_max_delay_ms": 3000,
        "ic_max_queue_items": 250,
        "gen_icecast_metadata": true,
        "alhls_enabled": true,
        "hls_part_duration": 500,
        "mp4_thumbnails": true,
        "mp4_thumbnails_interval": 6,
        "jpg_thumbnails": true,
        "jpg_thumbnails_interval": 6,
        "jpg_thumbnail_width": 4096,
        "jpg_thumbnail_height": 2048,
        "tags": ["Live sports"]
    }
}
```

**Response fields:** The same as in "Get an existing application". 

# **Delete**

Delete an existing application.  
**Request URL:**  
DELETE https://api.wmspanel.com/v1/server/\[server\_id\]/live/app/\[app\_id\]  
**Request parameters:**

* app\_id \- is ID of the application obtained via "Get applications list" method.  
* server\_id \- is ID of appropriate nimble server, you can get it from the "Get servers list" API call  
* client\_id \- is \[client\_id\] you've copied previously from UI  
* api\_key \- is \[api\_key\] from UI

**CURL request example:**  
curl \-X DELETE "https://api.wmspanel.com/v1/server/\[server\_id\]/live/app/552c97320640fdd1bf000002?client\_id=\[client\_id\]\&api\_key=\[api\_key\]"

**Response example:**

```
{
    "status" : "Ok",
}
```

