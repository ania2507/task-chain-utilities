import subprocess
import shlex
import platform
from metasphere.src.tools.logger import get_metasphere_logger

logger = get_metasphere_logger(__name__)

def exec_command(command):
    """
    Esegue un comando shell in modo cross-platform.
    
    Su Windows, converte apici singoli in doppi per compatibilità PowerShell.
    Su Unix, splitta il comando in lista per evitare problemi di escaping.
    
    Args:
        command (str): Il comando da eseguire.
    
    Returns:
        str: L'output del comando, o None se fallisce.
    """
    try:
        is_windows = platform.system() == "Windows"
        
        if is_windows:
            # Su Windows/PowerShell, sostituisci apici singoli con doppi
            # PowerShell usa doppi apici per le stringhe con caratteri speciali
            win_command = command.replace("'", '"')
            result = subprocess.run(
                win_command,
                shell=True,
                text=True,
                capture_output=True,
                check=True
            )
        else:
            # Su Unix, splitta in lista per gestione sicura degli argomenti
            args = shlex.split(command)
            result = subprocess.run(
                args,
                text=True,
                capture_output=True,
                check=True
            )
        
        logger.info(f"Eseguito comando: {command}")
        if "login" in command:
            if "\nFailed" in result.stdout:
                return None
            else:
                return "Ok"
        else:
            return result.stdout
    except subprocess.CalledProcessError as e:
        stderr_msg = e.stderr.strip() if e.stderr else "N/A"
        print(e)
        logger.error(f"Errore nell'esecuzione del comando: {command} - {e} - stderr: {stderr_msg}")
        return None
    except Exception as e:
        logger.error(f"Errore imprevisto nell'esecuzione del comando: {command} - {e}")
        return None