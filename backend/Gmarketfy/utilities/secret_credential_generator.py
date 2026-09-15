
import base64
from pathlib import Path
from Crypto.Cipher import PKCS1_v1_5
from Crypto.PublicKey import RSA
from decouple import config


def generate_security_credential(
    initiator_password: str | None = None, cert_path: str | Path | None = None
) -> str:
  """Generates a Base64-encoded Security Credential for Daraja Reversal, B2C, or B2B APIs.

  Reads default values from .env via python-decouple if parameters are not
  provided.

  :param initiator_password: Plaintext password for the M-Pesa Initiator user
  :param cert_path: Relative or absolute path to Safaricom's public certificate
  (.cer/.pem)
  :return: Encrypted Base64 string Security Credential
  """
  # 1. Fallback to .env config if parameters aren't explicitly passed
  password = initiator_password or config(
      'MPESA_INITIATOR_PASSWORD', default=''
  )
  certificate_path = cert_path or config(
      'MPESA_CERT_PATH', default='certs/ProductionCertificate.cer'
  )

  if not password:
    raise ValueError(
        'Initiator password is missing. Provide it or set MPESA_INITIATOR_PASSWORD in .env'
    )

  # 2. Resolve Path object safely
  path_obj = Path(certificate_path).resolve()
  if not path_obj.exists():
    raise FileNotFoundError(
        f'Safaricom certificate file not found at: {path_obj}'
    )

  try:
    # 3. Read & parse public key certificate
    with open(path_obj, 'rb') as cert_file:
      cert_data = cert_file.read()
      public_key = RSA.import_key(cert_data)

    # 4. Encrypt using PKCS1_v1_5 padding
    cipher = PKCS1_v1_5.new(public_key)
    encrypted_bytes = cipher.encrypt(password.encode('utf-8'))

    # 5. Return Base64 encoded string
    return base64.b64encode(encrypted_bytes).decode('utf-8')

  except Exception as e:
    raise RuntimeError(
        f'Failed to generate Security Credential: {str(e)}'
    ) from e

def main():
  credential = generate_security_credential()
  print('\n[+] Security Credential Generated Successfully:')
  print(credential)
  