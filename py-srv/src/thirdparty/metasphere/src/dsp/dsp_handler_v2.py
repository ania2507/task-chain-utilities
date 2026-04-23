import time
import json
import os
from datetime import datetime, timedelta

from metasphere.src.tools.logger import get_metasphere_logger
from metasphere.src.tools.dsp_tools import exec_command
from metasphere.src.tools.rest_tools import refresh_access_token, load_secrets
from metasphere.src.tools.rest_tools import rest_post_api

logger = get_metasphere_logger(__name__)

#cli_refresh_token_statement = "datasphere spaces list --verbose"


def extract_json_from_cli_output(cli_output: str) -> str:
    """
    Extract JSON from CLI output by removing trailing warnings/errors.
    This handles multi-line JSON followed by WARNING messages.
    
    Args:
        cli_output (str): Raw output from exec_command (may contain JSON + warnings)
    
    Returns:
        str: Valid JSON string (without trailing warnings)
    
    Example:
        Input:  '[\\n  "item1"\\n]\\nWARNING: node version ...'
        Output: '[\\n  "item1"\\n]'
    """
    if not cli_output:
        return ""
    
    lines = cli_output.split('\n')
    json_lines = []
    bracket_count = 0
    
    for line in lines:
        json_lines.append(line)
        
        # Count brackets to detect end of JSON
        bracket_count += line.count('[') + line.count('{')
        bracket_count -= line.count(']') + line.count('}')
        
        # When all brackets are closed, we've found the complete JSON
        if bracket_count == 0 and json_lines:
            break
    
    # Join back and strip whitespace
    json_str = '\n'.join(json_lines).strip()
    return json_str

class DSPHandler:

    # Variabili di classe per tracciare il timestamp dell'ultimo login
    _LAST_LOGIN_TIMESTAMP_ENV = "DSP_LAST_LOGIN_TIMESTAMP"
    _LOGIN_CACHE_DURATION_HOURS = 1

    def __init__(self, **kwargs):
        logger.info("Inizializzazione DSPHandler")

        self.client_id = kwargs.get("client_id")
        self.client_secret = kwargs.get("client_secret")
        self.hostname = kwargs.get("hostname")
        
        self.access_token = None
        self.token_expires_in = None

        # Controlla se il login è stato fatto negli ultimi 60 minuti
        if self._is_login_cached():
            logger.info("Login cache valido, skippo get_secret_status() e cli_login()")
        else:
            self.cli_secret_info = self.get_secret_status()

            make_login = (
                    self.cli_secret_info is None
                or self.client_id != self.cli_secret_info.get("client_id")
                or self.client_secret != self.cli_secret_info.get("client_secret")
                or self.hostname != self.cli_secret_info.get("tenantUrl")
            )

            if make_login:
                self.login_date = self.cli_login()
                if self.login_date is None:
                    logger.error("Login DSP fallito, impossibile procedere.")
                    raise Exception("DSP login failed")
                # Salva il timestamp del login nella variabile d'ambiente
            
            self._save_login_timestamp()
        
        #self.access_token = self.cli_get_token()

    def _is_login_cached(self) -> bool:
        """
        Verifica se il login è stato eseguito negli ultimi 60 minuti.
        
        Returns:
            bool: True se il cache è ancora valido, False altrimenti.
        """
        timestamp_str = os.environ.get(self._LAST_LOGIN_TIMESTAMP_ENV)
        
        if not timestamp_str:
            return False
        
        try:
            last_login = datetime.fromisoformat(timestamp_str)
            elapsed = datetime.now() - last_login
            cache_duration = timedelta(hours=self._LOGIN_CACHE_DURATION_HOURS)
            
            is_valid = elapsed < cache_duration
            if is_valid:
                logger.info(f"Login cache valido. Tempo trascorso: {elapsed.total_seconds():.0f}s / {cache_duration.total_seconds():.0f}s")
            else:
                logger.info(f"Login cache scaduto. Tempo trascorso: {elapsed.total_seconds():.0f}s > {cache_duration.total_seconds():.0f}s")
            
            return is_valid
        except Exception as e:
            logger.warning(f"Errore nel parsing timestamp di login cache: {e}")
            return False
    
    def _save_login_timestamp(self) -> None:
        """
        Salva il timestamp attuale nella variabile d'ambiente per tracciare l'ultimo login.
        """
        timestamp = datetime.now().isoformat()
        os.environ[self._LAST_LOGIN_TIMESTAMP_ENV] = timestamp
        logger.info(f"Timestamp di login salvato: {timestamp}")

    def cli_login(self):
        # Logout e pulizia configurazione
        result = exec_command("datasphere logout")
        #result = exec_command("datasphere config host clean")
        result = exec_command("datasphere config cache clean -P")

        # Login e nuova configurazione
        #quoted_path = f'"{self.secrets_path}"'
        result = exec_command(f"datasphere config host set {self.hostname}")
        result = exec_command(f"datasphere login --authorization-flow 'client_credentials' -c '{self.client_id}' -C '{self.client_secret}'")
        if result:
            logger.info("DSP CLI login eseguito con successo alle " + datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
        else:
            logger.error("DSP CLI login fallito.")
            return None

        return datetime.now()

    # def cli_get_token(self):

    #     result = exec_command(cli_refresh_token_statement)
    #     secret = self.get_secret_status()

    #     access_token = secret.get("access_token")
        
    #     logger.info("DSP CLI token refreshed.")
    #     return access_token

    def cli_create_object(self, space, object_type, object_name, json_tgt, overwrite=True):
        """
        Crea un oggetto DSP tramite CLI solo se non esiste, oppure lo sovrascrive se overwrite=True.
        Args:
            space (str): Lo spazio in cui creare l'oggetto.
            object_type (str): Il tipo di oggetto da creare (es. "transformationFlow").
            object_name (str): Il nome dell'oggetto da creare.
            json_tgt (str): Il percorso del file JSON che contiene la configurazione dell'oggetto.
            overwrite (bool): Se True, cancella e ricrea l'oggetto se già esistente.
        Returns:
            status (str): L'output della CLI.
        """
        # Verifica se l'oggetto esiste
        quoted_json_tgt = f'"{json_tgt}"'

        read_cmd = f"datasphere objects {object_type} list --space {space} --technical-names {object_name}"
        read_result = exec_command(read_cmd)
        # Extract JSON from output (ignore warnings)
        json_line = extract_json_from_cli_output(read_result)
        exists = (
            json_line != '[]'
        )

        if exists:
            if overwrite:
                # Cancella l'oggetto esistente
                #del_cmd = f"datasphere objects {object_type} delete --space {space} --technical-name {object_name} --force"
                #del_result = exec_command(del_cmd)
                #logger.info(f"Oggetto {object_name} cancellato in {space} (tipo {object_type}): {del_result}")
                logger.info(f"Oggetto {object_name} già esistente in {space} (tipo {object_type}), overwrite=True. Verrà eseguito l'update.")
                cmd = f"datasphere objects {object_type} update --space {space} --technical-name {object_name} --file-path {quoted_json_tgt}"
                result = exec_command(cmd)
                if result and "Failed to Deploy" in result:
                    logger.error(f"Deployment failed for {object_name} in {space}: {result}")
                    result = None
            else:
                logger.info(f"Oggetto {object_name} già esistente in {space} (tipo {object_type}), overwrite=False. Nessuna azione eseguita.")
                return read_result
        else:
        
            create_cmd = f"datasphere objects {object_type} create --space {space} --file-path {quoted_json_tgt}"       
            result = exec_command(create_cmd)
            if result and "Failed to Deploy" in result:
                logger.error(f"Deployment failed for {object_name} in {space}: {result}")
                result = None

        if result is None:            
            logger.error(f"Errore durante la creazione dell'oggetto {object_name} in {space} (tipo {object_type}): {result}")
            return None
        elif result is not None:
            logger.info(f"Oggetto {object_name}: deployato in {space} con tipo {object_type}")
        return result
    
    def cli_get_object_metadata(self, space, object_type, object_name):
        string = f"datasphere objects {object_type} read --space {space} --technical-name {object_name}"
        result = exec_command(string)
        logger.info(f"Retrived matadata for {object_name} in {space}")
        return result

    def cli_update_object(self, space, object_type, object_name, json_tgt):
        """
        Aggiorna un oggetto DSP tramite CLI.
        Args:
            space (str): Lo spazio in cui si trova l'oggetto.
            object_type (str): Il tipo di oggetto da aggiornare (es. "transformationFlow").
            object_name (str): Il nome dell'oggetto da aggiornare.
            json_tgt (str): Il percorso del file JSON che contiene la nuova configurazione dell'oggetto.
        Returns:
            status (str): L'output della CLI.
        """
        quoted_json_tgt = f'"{json_tgt}"'
        update_cmd = f"datasphere objects {object_type} update --space {space} --technical-name {object_name} --file-path {quoted_json_tgt}"
        result = exec_command(update_cmd)
        if result and "Failed to Deploy" in result:
            logger.error(f"Deployment failed for {object_name} in {space}: {result}")
            result = None
        
        if result is None:
            logger.error(f"Errore durante l'aggiornamento dell'oggetto {object_name} in {space} (tipo {object_type}): {result}")
            return None
        else:
            logger.info(f"Oggetto {object_name}: aggiornato in {space} con tipo {object_type}")
        
        return result

    def share_object_to_space(self, obj_name, source_space, target_space):
        """
        Condivide un oggetto con un altro spazio.
        Args:
            object_id (str): L'ID dell'oggetto da condividere.
            target_space_id (str): L'ID dello spazio di destinazione.
        Returns:
            response (str): La risposta della CLI.
        """
        import json
        url = f"{self.hostname}/dwaas-core/repository/shares"

        payload = json.dumps({
            "spaceName": source_space,
            "objectNames": [obj_name],
            "shareSpaceNames": [target_space],
            "unshareSpaceNames": []
        })

        response = rest_post_api(url, self.access_token, payload)
        
        return 1
    
    def check_object_exists(
            self,
            space: str, 
            object_type: str, 
            object_name: str
            ) -> bool:
        read_cmd = f"datasphere objects {object_type} list --space {space} --technical-names {object_name}"
        for attempt in range(2):
            read_result = exec_command(read_cmd)
            if read_result is not None:
                # Extract JSON from output (ignore warnings)
                json_line = extract_json_from_cli_output(read_result)
                if json_line != '[]':
                    return True
            if attempt == 0:
                time.sleep(5)
        logger.info(f"Object {object_name} of type {object_type} does not exist in space {space}.")
        return False
    
    def execute_free_command(self, cmd: str):
        result = exec_command(cmd)
        return result

    def dsp_get_object_space(self, object_type, object_name) -> str:
        """
        Recupera lo spazio di un oggetto dato il suo nome e tipo.
        Args:
            object_type (str): Il tipo di oggetto (es. "transformationFlow").
            object_name (str): Il nome dell'oggetto.
        Returns:
            space (str): Lo spazio in cui si trova l'oggetto.
        """

        spaces = []
        deduped = []

        cmd = "datasphere spaces list"
        result = exec_command(cmd)
        if not result:
            raise Exception("Unable to retrieve spaces list from datasphere CLI")
        else:
            # Extract JSON from output (ignore warnings)
            json_output = extract_json_from_cli_output(result)
            try:
                parsed = json.loads(json_output)
                # Handle nested lists like [[...]] by flattening one level
                if isinstance(parsed, list):
                    # if first element is a list, flatten one level
                    if parsed and isinstance(parsed[0], list):
                        parsed = parsed[0]
                    for e in parsed:
                        if isinstance(e, str):
                            spaces.append(e)
                        elif isinstance(e, dict):
                            # if items are dicts, try common keys
                            for k in ("name", "spaceName", "id", "displayName"):
                                if k in e and isinstance(e[k], str):
                                    spaces.append(e[k])
                                    break
            except Exception:
                # Fallback: remove brackets, quotes and split by commas or newlines
                lines = [l.strip() for l in result.splitlines() if l.strip()]
                for line in lines:
                    # ignore opening/closing JSON brackets
                    if line.startswith("[") or line.startswith("]"):
                        continue
                    # split by commas and strip quotes
                    for part in line.split(','):
                        tok = part.strip().strip('"').strip()
                        if tok:
                            spaces.append(tok)

            if len(spaces) == 0:
                raise Exception("No spaces found in datasphere CLI")
            else:
                # Deduplicate preserving order
                seen = set()
                deduped = []
                for s in spaces:
                    if s not in seen:
                        seen.add(s)
                        deduped.append(s)       

        # Search each space for the object
        for space in deduped:
            cmd = f"datasphere objects {object_type} list --technical-names {object_name} --space {space}"
            read_result = exec_command(cmd)
            if read_result is None:
                continue

            # Extract JSON from output (ignore warnings)
            json_line = extract_json_from_cli_output(read_result)
            
            # Prefer robust JSON parsing: the CLI returns [] or [{"technicalName": "NAME"}]
            found = False
            try:
                parsed = json.loads(json_line)
                if isinstance(parsed, list) and len(parsed) > 0:
                    for item in parsed:
                        if isinstance(item, dict):
                            tn = item.get("technicalName") or item.get("technicalname")
                            if tn and isinstance(tn, str) and tn.lower() == object_name.lower():
                                found = True
                                break
                        elif isinstance(item, str) and item.lower() == object_name.lower():
                            found = True
                            break
            except Exception:
                # Fallback: treat any non-empty, non-'[]' output as a hit
                if json_line != '[]' and json_line != '':
                    found = True

            if found:
                logger.info(f"Found object '{object_name}' of type '{object_type}' in space '{space}'")
                return space

        logger.info(f"Object {object_name} of type {object_type} not found in any space")
        return None

    def get_secret_status(self):
        """
        Recupera lo stato dei segreti dalla CLI di Datasphere e popola cli_secret_info.
        
        Returns:
            dict: Dizionario con chiavi: secret_exists, expires_in, token_type, tenantUrl, client_id, client_secret
        """
        result = exec_command("datasphere config secrets show")
        
        # Estrai JSON dall'output (rimuovi warnings)
        json_output = extract_json_from_cli_output(result)
        
        # Se l'output è vuoto o non inizia con '[' o '{', non è JSON
        if not json_output or not json_output.strip() or json_output.strip()[0] not in ['[', '{']:
            logger.warning(f"Output non JSON ricevuto da 'datasphere config secrets show': {json_output}")
            self.cli_secret_info = {
                "secret_exists": False,
                "expires_in": None,
                "token_type": None,
                "tenantUrl": None,
                "client_id": None,
                "client_secret": None
            }
            return self.cli_secret_info
        
        try:
            # Parse JSON output
            parsed = json.loads(json_output)
            
            # Il comando ritorna una lista; prendi il primo elemento se esiste
            if isinstance(parsed, list) and len(parsed) > 0:
                secret = parsed[0]
                
                # Popola cli_secret_info con i campi richiesti
                self.cli_secret_info = {
                    "secret_exists": True,
                    "expires_in": secret.get("expires_in"),
                    "token_type": secret.get("token_type"),
                    "tenantUrl": secret.get("tenantUrl"),
                    "client_id": secret.get("client_id"),
                    "client_secret": secret.get("client_secret")
                }
                logger.info(f"Segreti caricati con successo. Scadenza: {self.cli_secret_info['expires_in']}s")
            else:
                # Nessun secret trovato
                self.cli_secret_info = {
                    "secret_exists": False,
                    "expires_in": None,
                    "token_type": None,
                    "tenantUrl": None,
                    "client_id": None,
                    "client_secret": None
                }
                logger.warning("Nessun secret trovato nella configurazione Datasphere CLI")
        
        except json.JSONDecodeError as e:
            logger.error(f"Errore nel parsing JSON dei segreti (output: '{json_output}'): {e}")
            self.cli_secret_info = {
                "secret_exists": False,
                "expires_in": None,
                "token_type": None,
                "tenantUrl": None,
                "client_id": None,
                "client_secret": None
            }
        
        return self.cli_secret_info
    
    def launch_task_chain(self, space: str, task_chain_name: str) -> str:
        """
        Lancia una task chain in uno spazio specificato.
        
        Args:
            space (str): Lo spazio in cui lanciare la task chain.
            task_chain_name (str): Il nome tecnico della task chain da lanciare.
        Returns:
            logid (str): L'ID del log della task chain lanciata.
        """

        result = exec_command(f'datasphere tasks chains run --space "{space}" --object "{task_chain_name}"')
        
        # Estrai logId dal JSON nell'output
        json_str = extract_json_from_cli_output(result)
        if json_str:
            try:
                parsed = json.loads(json_str)
                logid = parsed.get("logId")
                if logid is not None:
                    logger.info(f"Task chain '{task_chain_name}' lanciata con Log ID: {logid}")
                    return str(logid)
            except json.JSONDecodeError as e:
                logger.warning(f"Errore nel parsing JSON del Log ID: {e}")
        
        # Fallback: restituisci l'output originale se non riusciamo a estrarre
        logger.warning(f"Impossibile estrarre Log ID da: {result}")
        return result
    
    def get_chain_status(self, space: str, logid: str, infolevel: str = "status") -> str:
        """
        Recupera lo stato di una task chain dato il suo Log ID.
        
        Args:
            space (str): Lo spazio in cui si trova la task chain.
            logid (str): L'ID del log della task chain.
        Returns:
            status (str): Lo stato corrente della task chain.
        """
        if infolevel:
            result = exec_command(f'datasphere tasks logs get --space "{space}" --log-id "{logid}" --infolevel {infolevel}')
        else:
            result = exec_command(f'datasphere tasks logs get --space "{space}" --log-id "{logid}"')
        return result