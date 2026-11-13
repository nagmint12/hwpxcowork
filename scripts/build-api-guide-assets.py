"""기관·계정 정보가 없는 API 연결 안내 예시 PNG를 생성한다."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
FONT = Path('C:/Windows/Fonts/malgun.ttf')


def build(filename, create=False):
    image = Image.new('RGB', (1200, 480), '#f4f6fa')
    draw = ImageDraw.Draw(image)
    font = lambda size: ImageFont.truetype(str(FONT), size)
    draw.rounded_rectangle((24, 24, 1176, 456), radius=18, fill='white', outline='#d9dfe8', width=2)
    draw.text((60, 48), 'API 키 생성' if create else 'API 키 관리', font=font(30), fill='#203047')
    draw.text((60, 100 if create else 200), '제공업체마다 화면과 메뉴가 다릅니다.', font=font(23), fill='#566478')
    if create:
        for y, label, value in [(160, '이름', 'HWPX 작업용'), (250, '설명', '개인 문서 검토용')]:
            draw.text((60, y), label, font=font(23), fill='#203047')
            draw.rounded_rectangle((200, y-8, 1120, y+58), radius=8, fill='#f6f8fb', outline='#cbd4df')
            draw.text((220, y), value, font=font(23), fill='#203047')
    else:
        draw.text((60, 260), '발급한 키는 비밀번호처럼 보관하세요.', font=font(23), fill='#566478')
    y = 370 if create else 90
    draw.rounded_rectangle((850, y, 1120, y+70), radius=10, fill='#203f69')
    draw.text((900, y+15), '생성하기' if create else 'API 키 생성', font=font(25), fill='white')
    draw.text((60, 391), '연결 안내용 예시 · 실제 계정 정보 없음', font=font(21), fill='#65748a')
    image.save(ROOT/'web'/'tutorial-assets'/filename)


if __name__ == '__main__':
    build('api-keys.png')
    build('api-create-key.png', create=True)
