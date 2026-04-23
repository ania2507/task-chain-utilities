import time
import json

from metasphere.src.tools.logger import get_metasphere_logger
from metasphere.src.tools.dsp_tools import exec_command
from metasphere.src.tools.rest_tools import refresh_access_token, load_secrets
from metasphere.src.tools.rest_tools import rest_post_api

logger = get_metasphere_logger(__name__)

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
    def __init__(self, secrets_path=None):
        logger.info("Inizializzazione DSPHandler")
        
        refresh_access_token(secrets_path)
        secrets = load_secrets(secrets_path)
        if secrets == 0:
            logger.error("Inizializzazione DSPHandler interrotta: secrets non caricati.")
            return
        auth_url, client_id, client_secret, refresh_token, hostname, access_token = secrets

        self.auth_url = auth_url
        self.client_id = client_id
        self.client_secret = client_secret
        self.refresh_token = refresh_token
        self.hostname = hostname
        self.access_token = access_token
        self.secrets_path = secrets_path

        self.cli_login()

    def cli_login(self):
        # Logout e pulizia configurazione
        result = exec_command("datasphere logout")
        result = exec_command("datasphere config host clean")
        result = exec_command("datasphere config cache clean -P")

        # Login e nuova configurazione
        quoted_path = f'"{self.secrets_path}"'
        result = exec_command(f"datasphere login --host {self.hostname} --secrets-file {quoted_path}")
        result = exec_command(f"datasphere config host set {self.hostname}")
        result = exec_command("datasphere config cache init --verbose")

        # Controllo risultato finale - extract first line to ignore warnings
        result_json = extract_json_from_cli_output(result)
        if result_json and "200 OK" in result_json:
            logger.info("Login DSP riuscito: 200 OK")
        else:
            logger.error(f"Login DSP fallito o risposta inattesa: {result_json}")

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
