import sys
import json
from metasphere.src.tools.rest_tools import interactive_token_flow
from metasphere.src.tools.logger import get_metasphere_logger

logger = get_metasphere_logger(__name__)

def initialize_dsp(path_secrets):
    """
    Inizializza l'ambiente DSP richiedendo le credenziali all'utente.
    Se il file dei secrets contiene già un access_token, esce con codice 1.
    """
    logger.info("Check secrets file per access token")
    try:
        with open(path_secrets, 'r', encoding='utf-8') as f:
            secrets = json.load(f)
        if secrets.get('access_token'):
            logger.info("Access token già presente. Nessuna inizializzazione necessaria.")
            return 1
    except Exception as e:
        logger.info(f"File secrets non trovato o non valido: {e}. Si procede con l'inizializzazione.")
    # Se non c'è il token, esegui il flow interattivo
    print("Inizializzazione MetaSphere Access Started...")
    result = interactive_token_flow(path_secrets)
    if result is None:
        print("Inizializzazione MetaSphere Access Failed: Nessun token ottenuto.")
        logger.info("Inizializzazione MetaSphere Access Failed: Nessun token ottenuto.")
        return
    print("Inizializzazione completata.")
    return result