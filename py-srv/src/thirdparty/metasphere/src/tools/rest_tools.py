import requests, json, os, base64
from dotenv import load_dotenv
from metasphere.src.tools.logger import get_metasphere_logger

logger = get_metasphere_logger(__name__)

def get_secrets_path(secrets_path=None):
    # Prima cerca nel parametro
    if secrets_path:
        path = secrets_path
    else:
        # Poi cerca nella variabile d'ambiente (che ora può essere caricata da .env)
        env_path = os.environ.get('SECRETS_PATH')
        if env_path:
            path = env_path
        else:
            # Fallback: due livelli sopra rispetto a questo file
            path = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', 'secrets', 'metasphere_secrets.json'))
    return path


def ensure_secret_dir(secrets_path=None):
    dir_path = (get_secrets_path(secrets_path))
    if not os.path.exists(dir_path):
        os.makedirs(dir_path)


def refresh_access_token(secrets_path=None):
    """
    Usa il file metasphere_secrets.json per ottenere un nuovo access token tramite il refresh token
    e aggiorna il file con i nuovi valori. Se il refresh token è scaduto, invita a rifare l'autenticazione interattiva.
    """
    ensure_secret_dir(secrets_path)
    secrets = load_secrets(secrets_path)
    if secrets == 0:
        logger.error("Impossibile aggiornare il token: secrets non caricati.")
        return
    auth_url, client_id, client_secret, refresh_token, *_ = secrets
    token_url = f"{auth_url}/oauth/token"
    auth_header = base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()
    headers = {
        "Authorization": f"Basic {auth_header}",
        "Content-Type": "application/x-www-form-urlencoded"
    }
    data = {
        "grant_type": "refresh_token",
        "refresh_token": refresh_token
    }
    response = requests.post(token_url, headers=headers, data=data)
    logger.info(f"Risposta refresh: {response.status_code}")
    if response.status_code != 200:
        logger.error("Errore nel refresh token. Probabilmente il refresh token è scaduto o non è valido. Esegui nuovamente l'autenticazione interattiva.")
        interactive_token_flow(secrets_path)
        return
    token_json = response.json()
    # Ricarica tutto il secrets per aggiornare solo i campi token
    with open(get_secrets_path(secrets_path), "r", encoding="utf-8") as f:
        secrets = json.load(f)
    secrets["access_token"] = token_json.get("access_token")
    secrets["refresh_token"] = token_json.get("refresh_token")
    secrets["expires_in"] = token_json.get("expires_in")
    secrets["scope"] = token_json.get("scope")
    secrets["jti"] = token_json.get("jti")
    secrets["token_type"] = token_json.get("token_type")
    secrets["id_token"] = token_json.get("id_token")
    with open(get_secrets_path(secrets_path), "w", encoding="utf-8") as f:
        json.dump(secrets, f, indent=2)
    logger.info("Token aggiornato in metasphere_secrets.json")


def interactive_token_flow(secrets_path):
    """
    1. Mostra la URL per ottenere il code.
    2. Attende che l'utente incolli il code.
    3. Scambia il code per i token e salva tutto in metasphere_secrets.json.
    """
    ensure_secret_dir(secrets_path)
    # Se il file dei secrets esiste, prendi i parametri da lì
    secrets_file = get_secrets_path(secrets_path)
    if os.path.exists(secrets_file):
        with open(secrets_file, "r", encoding="utf-8") as f:
            secrets = json.load(f)
        auth_url = secrets.get('auth_url')
        client_id = secrets.get('client_id')
        client_secret = secrets.get('client_secret')
        hostname = secrets.get('hostname')
    else:
        auth_url = os.getenv('AUTH_URL')
        client_id = os.getenv('CLIENT_ID')
        client_secret = os.getenv('CLIENT_SECRET')
        hostname = os.getenv('HOSTNAME')

    url = f"{auth_url}/oauth/authorize?response_type=code&client_id={client_id}"
    print("Apri questo link nel browser, effettua il login e copia il code dalla barra degli indirizzi:")
    print(url)
    code = input("\nIncolla qui il code ottenuto e premi invio: ").strip()
    token_url = f"{auth_url}/oauth/token"
    auth_header = base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()
    headers_token = {
        "Authorization": f"Basic {auth_header}",
        "Content-Type": "application/x-www-form-urlencoded"
    }
    data_token = {
        "code": code,
        "grant_type": "authorization_code"
    }
    response_token = requests.post(token_url, headers=headers_token, data=data_token)
    response_token.raise_for_status()
    token_json = response_token.json()
    secrets = {
        "auth_url": auth_url,
        "client_id": client_id,
        "client_secret": client_secret,
        "hostname": hostname,
        "access_token": token_json.get("access_token"),
        "refresh_token": token_json.get("refresh_token"),
        "expires_in": token_json.get("expires_in"),
        "scope": token_json.get("scope"),
        "jti": token_json.get("jti"),
        "token_type": token_json.get("token_type"),
        "id_token": token_json.get("id_token")
    }
    with open(get_secrets_path(secrets_path), "w", encoding="utf-8") as f:
        json.dump(secrets, f, indent=2)
    logger.info("Dati salvati in metasphere_secrets.json")
    return 1


def ensure_and_refresh_or_init(secrets_path=None):
    """
    Verifica se esiste il file metasphere_secrets.json nella cartella secrets.
    Se esiste, fa il refresh del token. Se non esiste, avvia l'interactive flow.
    """
    if os.path.exists(get_secrets_path(secrets_path)):
        print(f"Trovato {get_secrets_path(secrets_path)}. Eseguo refresh token")
        refresh_access_token(secrets_path)
    else:
        print(f"{get_secrets_path(secrets_path)} non trovato. Avvio inizializzazione interattiva")
        interactive_token_flow(secrets_path)


def rest_post_api(url, token, data):
    """
    Esegue una richiesta POST all'API REST del DeepSea.
    
    Args:
        url (str): L'URL del tenant del DeepSea.
        token (str): Il token di accesso.
        data (dict or str): Il payload della richiesta.
        
    Returns:
        requests.models.Response: La risposta dell'API oppure None in caso di errore.
    """
    try:
        # Il .env deve essere già caricato dal programma principale
        auth_type = os.getenv('REST_AUTH_TYPE')
        verify_ssl = os.getenv('REST_VERIFY_SSL', 'True').lower() == 'true'

        if auth_type and auth_type.lower() == 'sessionid':
            username = os.getenv('REST_USERNAME')
            password = os.getenv('REST_PASSWORD')
            jsessionid = os.getenv('REST_SESSIONID')
            auth = (username, password)
            cookies = {"JSESSIONID": jsessionid}
            headers = {"Accept": "application/json", "Content-Type": "application/json"}
            if isinstance(data, (dict, list)):
                data_json = data
            else:
                try:
                    data_json = json.loads(data)
                except Exception as e:
                    logger.error(f"Payload non valido per POST: {e}")
                    return 0
            response = requests.post(url, auth=auth, cookies=cookies, headers=headers, json=data_json, verify=True)
        else:
            headers = {
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
                "Accept": "application/json"
            }
            if isinstance(data, (dict, list)):
                data_json = data
            else:
                try:
                    data_json = json.loads(data)
                except Exception as e:
                    logger.error(f"Payload non valido per POST: {e}")
                    return 0
            response = requests.post(url, headers=headers, json=data_json, verify=verify_ssl)
        logger.info(f"POST {url} status={response.status_code}")
        if not (200 <= response.status_code < 300):
            logger.error(f"POST {url} fallita con status {response.status_code}: {response.text}")
            return 0
        return response
    except requests.RequestException as e:
        logger.error(f"POST {url} failed: {e}")
        return 0

def rest_get_api(url, token):
    """
    Esegue una richiesta GET all'API REST del DeepSea.
    
    Args:
        url (str): L'URL del tenant del DeepSea.
        token (str): Il token di accesso.
        
    Returns:
        requests.models.Response: La risposta dell'API oppure None in caso di errore.
    """
    try:
        # Il .env deve essere già caricato dal programma principale
        auth_type = os.getenv('REST_AUTH_TYPE')
        verify_ssl = os.getenv('REST_VERIFY_SSL', 'True').lower() == 'true'

        if auth_type and auth_type.lower() == 'sessionid':
            username = os.getenv('REST_USERNAME')
            password = os.getenv('REST_PASSWORD')
            jsessionid = os.getenv('REST_SESSIONID')
            auth = (username, password)
            cookies = {"JSESSIONID": jsessionid}
            headers = {"Accept": "application/json"}
            response = requests.get(url, auth=auth, cookies=cookies, headers=headers, verify=verify_ssl)
        else:
            headers = {
                "Authorization": f"Bearer {token}",
                "Accept": "application/json"
            }
            response = requests.get(url, headers=headers, verify=verify_ssl)
        logger.info(f"GET {url} status={response.status_code}")
        if not (200 <= response.status_code < 300):
            logger.error(f"GET {url} fallita con status {response.status_code}: {response.text}")
            return 0
        return response
    except requests.RequestException as e:
        logger.error(f"GET {url} failed: {e}")
        return 0

def load_secrets(secrets_path=None):
    secrets_file = get_secrets_path(secrets_path)
    try:
        with open(secrets_file, "r", encoding="utf-8") as f:
            secrets = json.load(f)
        auth_url = secrets["auth_url"]
        client_id = secrets["client_id"]
        client_secret = secrets["client_secret"]
        refresh_token = secrets["refresh_token"]
        hostname = secrets["hostname"]
        access_token = secrets["access_token"]
        return auth_url, client_id, client_secret, refresh_token, hostname, access_token
    except (FileNotFoundError, json.JSONDecodeError, KeyError) as e:
        logger.error(f"Errore nella lettura del file di secrets: {e}")
        return 0