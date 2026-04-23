import logging

def get_metasphere_logger(name=None):
    """
    Restituisce un logger con prefisso 'METASPHERE' nel nome.
    Esempio: METASPHERE.src.tools.dsp_tools
    """
    base = "METASPHERE"
    if name:
        logger_name = f"{base}.{name}"
    else:
        logger_name = base
    return logging.getLogger(logger_name)