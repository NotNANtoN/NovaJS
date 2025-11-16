import 'jasmine';
import { getDefaultPictImageData } from './PictImage.js';

describe('PictImage', () => {
    it('gets the default pict data', () => {
        expect(getDefaultPictImageData()).toBeDefined();
    });
});
