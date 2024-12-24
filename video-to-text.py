from whisperplus.pipelines import mlx_whisper
from whisperplus import download_youtube_to_mp3

url = "https://www.youtube.com/watch?v=1__CAdTJ5JU"
audio_path = download_youtube_to_mp3(url)

text = mlx_whisper.transcribe(
    audio_path, path_or_hf_repo="mlx-community/whisper-large-v3-mlx"
)["text"]
print(text)
