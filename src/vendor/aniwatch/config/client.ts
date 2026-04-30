/**
 * Axios HTTP client configuration
 */

import axios from "axios";
import {
    ACCEPT_ENCODING_HEADER,
    USER_AGENT_HEADER,
    ACCEPT_HEADER,
    SEC_CH_UA_HEADER,
    ACCEPT_LANGUAGE_HEADER,
} from "../utils/constants.js";

const clientConfig = {
    timeout: 15000,
    headers: {
        Accept: ACCEPT_HEADER,
        "User-Agent": USER_AGENT_HEADER,
        "Accept-Encoding": ACCEPT_ENCODING_HEADER,
        "Accept-Language": ACCEPT_LANGUAGE_HEADER,
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
        "sec-ch-ua": SEC_CH_UA_HEADER,
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "none",
        "sec-fetch-user": "?1",
        "upgrade-insecure-requests": "1",
    },
};

export const client = axios.create(clientConfig);
export type { AxiosError } from "axios";
