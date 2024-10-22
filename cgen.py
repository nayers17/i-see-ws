# backend/content_generator.py

import os
import requests
from dotenv import load_dotenv

load_dotenv()

HF_API_KEY = os.getenv("HF_API_KEY")
print("Hugging Face API Key:", HF_API_KEY)
API_ENDPOINT = "https://api-inference.huggingface.co/meta-llama/Llama-3.2-3B"

def generate_content(prompt):
    headers = {
        "Authorization": f"Bearer {HF_API_KEY}",
        "Content-Type": "application/json"
    }
    payload = {
        "inputs": prompt
    }

    response = requests.post(API_ENDPOINT, json=payload, headers=headers)

    if response.status_code == 200:
        return response.json().get("generated_text", "No content generated")
    else:
        print(f"Error: {response.status_code}, {response.text}")
        return None

# Example usage
prompt = "Write a detailed blog post about the latest trends in artificial intelligence for 2024."
content = generate_content(prompt)

if content:
    print("Generated Content:", content)
else:
    print("Failed to generate content")
