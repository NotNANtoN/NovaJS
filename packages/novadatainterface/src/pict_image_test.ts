import 'jasmine';
import { getDefaultPictImageData } from './pict_image.js';

describe('PictImage', () => {
    it('gets the default pict data', () => {
        expect(getDefaultPictImageData()).toBeDefined();
    });
});
